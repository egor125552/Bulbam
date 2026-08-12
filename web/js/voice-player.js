import { announce, getCurrentAccount } from "./ui.js";

const SPEED_KEY = "bulbam.voice.playbackRate";
const SPEEDS = [1, 1.5, 2];
const CACHE_LIMIT = 30;
const HEARTBEAT_MS = 5000;
const LISTEN_GAP_MS = 1200;

const controllers = new Map();
let messageSequence = [];
let playbackRate = readPlaybackRate();
let previousAccountId = null;

export function setupVoicePlayer() {
  window.addEventListener("bulbam:account-changed", (event) => {
    const nextAccountId = event.detail?.account?.userId ?? null;
    if (!nextAccountId && previousAccountId) void caches.delete(cacheName(previousAccountId)).catch(() => undefined);
    previousAccountId = nextAccountId;
  });
}

export function setVoiceMessageSequence(messages) {
  messageSequence = messages.map((message) => ({ messageId: message.messageId, kind: message.kind }));
}

export function renderVoiceMessage(message, mine) {
  const voice = message.voice;
  const root = document.createElement("section");
  root.className = "voice-message";
  root.setAttribute("aria-label", `Голосовое сообщение, ${formatTime(voice.durationMs)}`);

  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = voice.localUrl || voiceUrl(message);

  const actions = document.createElement("div");
  actions.className = "voice-actions";
  const play = button("Воспроизвести");
  const back = button("Назад на 15 секунд");
  const forward = button("Вперёд на 15 секунд");
  const speed = button(`${formatSpeed(playbackRate)} скорость`);

  const progress = document.createElement("input");
  progress.type = "range";
  progress.className = "voice-progress";
  progress.min = "0";
  progress.max = String(Math.max(0.1, voice.durationMs / 1000));
  progress.step = "0.1";
  progress.value = String(Math.min(Number(progress.max), (voice.progress?.resumeMs ?? 0) / 1000));
  progress.setAttribute("aria-label", "Положение голосового сообщения");

  const time = document.createElement("span");
  time.className = "voice-time";
  const initialPositionMs = voice.progress?.resumeMs ?? 0;
  time.textContent = `${formatTime(initialPositionMs)} из ${formatTime(voice.durationMs)}`;

  const listenStatus = document.createElement("span");
  listenStatus.className = "voice-listen-status";
  listenStatus.dataset.messageId = message.messageId;
  updateListenStatus(listenStatus, voice.progress, false, mine);

  actions.append(play, back, forward, speed);
  root.append(audio, actions, progress, time, listenStatus);

  const controller = {
    message,
    mine,
    root,
    audio,
    play,
    progress,
    time,
    listenStatus,
    heardRanges: mergeRanges([...(voice.progress?.heardRanges ?? [])]),
    lastMediaTimeMs: initialPositionMs,
    lastProgressSentAt: 0,
    heartbeatTimer: null,
    remoteStaleTimer: null,
    buffering: false,
    objectUrl: null,
    preparedSource: false
  };
  controllers.set(message.messageId, controller);

  play.addEventListener("click", () => void togglePlayback(controller));
  back.addEventListener("click", () => seekBy(controller, -15));
  forward.addEventListener("click", () => seekBy(controller, 15));
  speed.addEventListener("click", () => {
    playbackRate = nextSpeed(playbackRate);
    localStorage.setItem(SPEED_KEY, String(playbackRate));
    for (const candidate of controllers.values()) candidate.audio.playbackRate = playbackRate;
    speed.textContent = `${formatSpeed(playbackRate)} скорость`;
    announce(`Скорость голосовых ${formatSpeed(playbackRate)}.`);
  });
  progress.addEventListener("input", () => {
    audio.currentTime = Number(progress.value);
    controller.lastMediaTimeMs = audio.currentTime * 1000;
    updateTime(controller);
  });
  progress.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(controller, event.key === "ArrowLeft" ? -15 : 15);
    }
  });

  audio.playbackRate = playbackRate;
  audio.addEventListener("play", () => {
    play.textContent = "Пауза";
    startHeartbeat(controller);
    void prefetchNextVoice(message.messageId);
  });
  audio.addEventListener("pause", () => {
    play.textContent = "Воспроизвести";
    stopHeartbeat(controller);
    void sendProgress(controller, false, false);
  });
  audio.addEventListener("timeupdate", () => {
    trackHeardRange(controller);
    updateTime(controller);
  });
  audio.addEventListener("seeking", () => {
    controller.lastMediaTimeMs = audio.currentTime * 1000;
  });
  audio.addEventListener("waiting", () => {
    controller.buffering = true;
    announce("Буферизация голосового сообщения.");
  });
  audio.addEventListener("playing", () => {
    if (controller.buffering) announce("Воспроизведение голосового продолжено.");
    controller.buffering = false;
  });
  audio.addEventListener("ended", () => void handleEnded(controller));
  audio.addEventListener("error", () => {
    stopHeartbeat(controller);
    announce("Не удалось воспроизвести голосовое сообщение.");
  });

  return root;
}

export function applyRemoteVoiceProgress(messageId, progress, active, staleAt) {
  const controller = controllers.get(messageId);
  if (!controller) return;
  controller.message.voice.progress = progress;
  updateListenStatus(controller.listenStatus, progress, active, controller.mine);
  clearTimeout(controller.remoteStaleTimer);
  controller.remoteStaleTimer = null;
  if (active && staleAt) {
    controller.remoteStaleTimer = setTimeout(() => {
      updateListenStatus(controller.listenStatus, progress, false, controller.mine);
    }, Math.max(0, staleAt - Date.now()));
  }
}

export function captureVoicePlaybackState() {
  const states = [];
  for (const [messageId, controller] of controllers) {
    if (controller.audio.paused && controller.audio.currentTime === 0) continue;
    states.push({
      messageId,
      currentTime: controller.audio.currentTime,
      playing: !controller.audio.paused,
      playbackRate: controller.audio.playbackRate
    });
  }
  return states;
}

export async function restoreVoicePlaybackState(states) {
  for (const state of states) {
    const controller = controllers.get(state.messageId);
    if (!controller) continue;
    controller.audio.currentTime = state.currentTime;
    controller.audio.playbackRate = state.playbackRate;
    if (state.playing) await controller.audio.play().catch(() => undefined);
  }
}

export function resetVoicePlayers() {
  for (const controller of controllers.values()) {
    stopHeartbeat(controller);
    clearTimeout(controller.remoteStaleTimer);
    controller.remoteStaleTimer = null;
    if (controller.objectUrl) URL.revokeObjectURL(controller.objectUrl);
  }
  controllers.clear();
}

async function togglePlayback(controller) {
  if (controller.audio.paused) {
    await prepareCachedSource(controller);
    await pauseOtherPlayers(controller.message.messageId);
    if (controller.audio.currentTime === 0 && controller.message.voice.progress?.resumeMs) {
      controller.audio.currentTime = controller.message.voice.progress.resumeMs / 1000;
    }
    await controller.audio.play().catch((error) => announce(`Не удалось начать воспроизведение: ${error.message}`));
  } else {
    controller.audio.pause();
  }
}

async function prepareCachedSource(controller) {
  if (controller.preparedSource || controller.message.voice.localUrl || !window.caches) return;
  controller.preparedSource = true;
  const account = getCurrentAccount();
  if (!account) return;
  try {
    const cache = await caches.open(cacheName(account.userId));
    const cached = await cache.match(voiceUrl(controller.message));
    if (!cached) return;
    const blob = await cached.blob();
    controller.objectUrl = URL.createObjectURL(blob);
    const position = controller.audio.currentTime;
    controller.audio.src = controller.objectUrl;
    controller.audio.currentTime = position;
  } catch {
    // Streaming remains available when Cache Storage is unavailable.
  }
}

async function pauseOtherPlayers(exceptMessageId) {
  for (const [messageId, controller] of controllers) {
    if (messageId !== exceptMessageId && !controller.audio.paused) controller.audio.pause();
  }
}

function seekBy(controller, seconds) {
  const next = Math.min(controller.message.voice.durationMs / 1000, Math.max(0, controller.audio.currentTime + seconds));
  controller.audio.currentTime = next;
  controller.lastMediaTimeMs = next * 1000;
  updateTime(controller);
  announce(`${seconds < 0 ? "Назад" : "Вперёд"} на 15 секунд. ${formatTime(next * 1000)}.`);
}

function trackHeardRange(controller) {
  if (controller.audio.paused || controller.audio.seeking) {
    controller.lastMediaTimeMs = controller.audio.currentTime * 1000;
    return;
  }
  const currentMs = controller.audio.currentTime * 1000;
  const previousMs = controller.lastMediaTimeMs;
  const delta = currentMs - previousMs;
  if (delta > 0 && delta <= LISTEN_GAP_MS * controller.audio.playbackRate) {
    controller.heardRanges = mergeRanges([...controller.heardRanges, [previousMs, currentMs]]);
  }
  controller.lastMediaTimeMs = currentMs;
}

function updateTime(controller) {
  controller.progress.value = String(controller.audio.currentTime);
  controller.time.textContent = `${formatTime(controller.audio.currentTime * 1000)} из ${formatTime(controller.message.voice.durationMs)}`;
  controller.progress.setAttribute(
    "aria-valuetext",
    `${formatTime(controller.audio.currentTime * 1000)} из ${formatTime(controller.message.voice.durationMs)}`
  );
}

function startHeartbeat(controller) {
  stopHeartbeat(controller);
  void sendProgress(controller, true, false);
  controller.heartbeatTimer = setInterval(() => void sendProgress(controller, true, false), HEARTBEAT_MS);
}

function stopHeartbeat(controller) {
  if (controller.heartbeatTimer) clearInterval(controller.heartbeatTimer);
  controller.heartbeatTimer = null;
}

async function sendProgress(controller, active, completed) {
  if (controller.mine || controller.message.localState) return;
  const now = Date.now();
  if (active && now - controller.lastProgressSentAt < HEARTBEAT_MS - 500) return;
  controller.lastProgressSentAt = now;
  try {
    const response = await fetch(
      `/api/v1/chats/${controller.message.conversationId}/messages/${controller.message.messageId}/voice/progress`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          heardRanges: controller.heardRanges.map(([start, end]) => [Math.round(start), Math.round(end)]),
          resumeMs: Math.round(controller.audio.currentTime * 1000),
          completed,
          active
        })
      }
    );
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.progress) {
      controller.message.voice.progress = payload.progress;
      controller.heardRanges = mergeRanges(payload.progress.heardRanges ?? controller.heardRanges);
    }
  } catch {
    // Playback remains usable offline; the next heartbeat carries the merged progress.
  }
}

async function handleEnded(controller) {
  stopHeartbeat(controller);
  trackHeardRange(controller);
  const listenedMs = totalRangeDuration(controller.heardRanges);
  const complete = listenedMs >= Math.max(0, controller.message.voice.durationMs - 1500);
  await sendProgress(controller, false, complete);
  void cacheVoice(controller.message);

  const index = messageSequence.findIndex((entry) => entry.messageId === controller.message.messageId);
  const next = messageSequence[index + 1];
  if (next?.kind !== "voice") return;
  const nextController = controllers.get(next.messageId);
  if (!nextController) return;
  await togglePlayback(nextController);
}

async function prefetchNextVoice(messageId) {
  const index = messageSequence.findIndex((entry) => entry.messageId === messageId);
  const next = messageSequence[index + 1];
  if (next?.kind !== "voice") return;
  const controller = controllers.get(next.messageId);
  if (!controller || controller.message.voice.localUrl) return;
  try {
    const response = await fetch(voiceUrl(controller.message), {
      credentials: "same-origin",
      headers: { range: "bytes=0-65535" }
    });
    if (response.ok || response.status === 206) await response.arrayBuffer();
  } catch {
    // Prefetch is optional and must never block current playback.
  }
}

async function cacheVoice(message) {
  if (!window.caches || message.voice.localUrl) return;
  const account = getCurrentAccount();
  if (!account) return;
  try {
    const cache = await caches.open(cacheName(account.userId));
    const url = voiceUrl(message);
    if (!(await cache.match(url))) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (response.ok) await cache.put(url, response.clone());
    }
    const keys = await cache.keys();
    while (keys.length > CACHE_LIMIT) {
      const oldest = keys.shift();
      if (oldest) await cache.delete(oldest);
    }
  } catch {
    // Device cache is an optimization; R2 remains the source of truth.
  }
}

function updateListenStatus(element, progress, active, mine) {
  if (!mine) {
    element.textContent = "";
    element.hidden = true;
    return;
  }
  element.hidden = false;
  if (active) {
    element.textContent = "Сейчас слушает ваше голосовое";
    return;
  }
  if (progress?.completedAt) {
    element.textContent = "Прослушано полностью";
    return;
  }
  if (progress?.listenedMs > 0) {
    element.textContent = `Прослушано ${formatTime(progress.listenedMs)}`;
    return;
  }
  element.textContent = "Не прослушано";
}

function mergeRanges(ranges) {
  const normalized = ranges
    .map(([start, end]) => [Math.max(0, Number(start)), Math.max(0, Number(end))])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1] + 250) merged.push([...range]);
    else last[1] = Math.max(last[1], range[1]);
  }
  return merged.slice(0, 256);
}

function totalRangeDuration(ranges) {
  return mergeRanges(ranges).reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}

function voiceUrl(message) {
  return `/api/v1/chats/${message.conversationId}/messages/${message.messageId}/voice/audio`;
}

function cacheName(accountId) {
  return `bulbam-voice-cache-v1-${accountId}`;
}

function button(text) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  return element;
}

function nextSpeed(current) {
  const index = SPEEDS.indexOf(current);
  return SPEEDS[(index + 1) % SPEEDS.length];
}

function readPlaybackRate() {
  const value = Number(localStorage.getItem(SPEED_KEY));
  return SPEEDS.includes(value) ? value : 1;
}

function formatSpeed(value) {
  return `${String(value).replace(".", ",")}×`;
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
