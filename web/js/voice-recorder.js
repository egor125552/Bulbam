import { api } from "./api.js";
import { announce, getCurrentAccount } from "./ui.js";
import {
  acceptExternalMessage,
  getSelectedChat,
  refreshChatsAfterExternalMessage
} from "./messenger.js";
import { playVoiceCue, prepareVoiceCues } from "./voice-cues.js";
import {
  appendVoiceChunk,
  createVoiceDraft,
  deleteVoiceDraft,
  findRecoverableVoiceDraft,
  getVoiceDraft,
  getVoicePartBlob,
  updateVoiceDraft
} from "./voice-drafts.js";
import { getVoiceBitrate } from "./voice-settings.js";
import { VoiceUploadSocket } from "./voice-upload-socket.js";

const LOCAL_PART_SIZE = 256 * 1024;
const OPTION_HOLD_DELAY_MS = 220;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"];

let recordButton = null;
let draftPanel = null;
let draftStatus = null;
let draftSendButton = null;
let draftDeleteButton = null;
let recordingStatus = null;
let recordingTimer = null;
let current = null;
let starting = false;
let recoverableDraft = null;
let optionTimer = null;
let optionBlocked = false;
let optionHeld = false;

export function setupVoiceRecorder() {
  recordButton = document.querySelector("#voice-record-button");
  draftPanel = document.querySelector("#voice-draft-panel");
  draftStatus = document.querySelector("#voice-draft-status");
  draftSendButton = document.querySelector("#voice-draft-send");
  draftDeleteButton = document.querySelector("#voice-draft-delete");
  recordingStatus = document.querySelector("#voice-recording-status");
  recordButton?.addEventListener("click", () => {
    void prepareVoiceCues();
    void toggleButtonRecording();
  });
  draftSendButton?.addEventListener("click", () => void sendRecoverableDraft());
  draftDeleteButton?.addEventListener("click", () => void deleteRecoverableDraft());

  window.addEventListener("bulbam:chat-changed", handleChatChanged);
  window.addEventListener("bulbam:account-changed", handleAccountChanged);
  window.addEventListener("online", () => void refreshRecoverableDraft());
  observeCallPanel();

  document.addEventListener("keydown", handleOptionKeyDown, true);
  document.addEventListener("keyup", handleOptionKeyUp, true);
  window.addEventListener("blur", () => {
    optionHeld = false;
    clearOptionTimer();
    if (current?.trigger === "option") void interruptRecording("Окно потеряло фокус во время записи.");
  });
}

function handleChatChanged(event) {
  const nextConversationId = event.detail?.chat?.conversationId ?? null;
  if (current && nextConversationId !== current.draft.conversationId) {
    void interruptRecording("Чат был изменён во время записи.");
  }
  void refreshRecoverableDraft();
}

function handleAccountChanged(event) {
  const nextAccountId = event.detail?.account?.userId ?? null;
  clearOptionTimer();
  optionHeld = false;
  optionBlocked = false;
  if (current && nextAccountId !== current.draft.accountId) {
    void interruptRecording("Аккаунт был изменён во время записи.");
  }
  void refreshRecoverableDraft();
}

function observeCallPanel() {
  const callPanel = document.querySelector("#call-panel");
  if (!callPanel || !window.MutationObserver) return;
  const observer = new MutationObserver(() => {
    if (current && !callPanel.hidden) {
      void interruptRecording("Звонок начался во время записи.");
    }
  });
  observer.observe(callPanel, { attributes: true, attributeFilter: ["hidden"] });
}

async function toggleButtonRecording() {
  if (starting) return;
  if (current) {
    await stopAndSend();
    return;
  }
  await startRecording("button");
}

async function startRecording(trigger) {
  const account = getCurrentAccount();
  const chat = getSelectedChat();
  if (!account || !chat || current || starting) return;

  starting = true;
  setStartingUi(true);
  const expectedAccountId = account.userId;
  const expectedConversationId = chat.conversationId;
  let stream = null;
  let localId = null;

  try {
    if (isCallActive()) {
      announce("Во время активного звонка запись голосового недоступна.");
      await playVoiceCue("error");
      return;
    }
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      announce("Этот браузер не умеет записывать голосовые сообщения.");
      await playVoiceCue("error");
      return;
    }

    const mimeType = chooseOpusMimeType();
    if (!mimeType) {
      announce("Браузер не умеет записывать Opus для голосовых сообщений.");
      await playVoiceCue("error");
      return;
    }

    const bitrateBps = getVoiceBitrate();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      await enforceRawCapture(stream);
    } catch (error) {
      announce(`Не удалось включить микрофон: ${error.message}`);
      await playVoiceCue("error");
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      return;
    }

    if (!canFinishStarting(expectedAccountId, expectedConversationId, trigger, stream)) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      announce("Запись не началась: чат, аккаунт, звонок или состояние клавиши изменились во время запуска.");
      await playVoiceCue("error");
      return;
    }

    localId = randomId();
    const draft = {
      id: localId,
      accountId: expectedAccountId,
      conversationId: expectedConversationId,
      clientMessageId: randomId(),
      mimeType,
      bitrateBps,
      startedAt: Date.now(),
      lastChunkAt: Date.now(),
      totalBytes: 0,
      sequence: 0,
      state: "recording",
      upload: null,
      interruptionReason: null
    };

    try {
      await createVoiceDraft(draft);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      announce(`Не удалось подготовить надёжное хранение записи: ${error.message}`);
      await playVoiceCue("error");
      return;
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: bitrateBps });
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      await deleteVoiceDraft(localId).catch(() => undefined);
      localId = null;
      announce(`Не удалось запустить запись Opus: ${error.message}`);
      await playVoiceCue("error");
      return;
    }

    const state = {
      draft,
      recorder,
      stream,
      trigger,
      stopMode: null,
      dataQueue: Promise.resolve(),
      uploadQueue: Promise.resolve(),
      uploadPromise: null,
      transport: null,
      finishing: false
    };

    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data?.size) return;
      state.dataQueue = state.dataQueue.then(() => persistChunk(state, event.data));
    });
    recorder.addEventListener("error", () => void interruptRecording("Ошибка записи микрофона."));
    recorder.addEventListener("stop", () => void finishStoppedRecorder(state));
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (current === state && !state.stopMode) void interruptRecording("Микрофон был отключён системой.");
      });
    }

    await playVoiceCue("start");
    if (!canFinishStarting(expectedAccountId, expectedConversationId, trigger, stream)) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      await deleteVoiceDraft(localId).catch(() => undefined);
      localId = null;
      announce("Запись не началась: контекст изменился во время стартового сигнала.");
      await playVoiceCue("error");
      return;
    }

    current = state;
    try {
      recorder.start(1000);
    } catch (error) {
      if (current === state) current = null;
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      await deleteVoiceDraft(localId).catch(() => undefined);
      localId = null;
      announce(`Не удалось начать запись: ${error.message}`);
      await playVoiceCue("error");
      return;
    }

    localId = null;
    stream = null;
    // Не создаём server upload заранее. Для короткой или отменённой записи это
    // лишняя сессия; длинная запись создаст её сама при первом полном 256-KiB куске.
    setRecordingUi(true, draft.startedAt);
    announce(trigger === "option"
      ? "Запись голосового началась. Отпусти Option, чтобы отправить. Escape отменяет запись."
      : "Запись голосового началась. Нажми кнопку ещё раз, чтобы отправить.");
  } finally {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (localId) await deleteVoiceDraft(localId).catch(() => undefined);
    starting = false;
    setStartingUi(false);
    void refreshRecoverableDraft();
  }
}

function canFinishStarting(expectedAccountId, expectedConversationId, trigger, stream) {
  const account = getCurrentAccount();
  const chat = getSelectedChat();
  const hasLiveTrack = stream?.getAudioTracks?.().some((track) => track.readyState !== "ended") === true;
  if (!account || account.userId !== expectedAccountId) return false;
  if (!chat || chat.conversationId !== expectedConversationId) return false;
  if (isCallActive() || !hasLiveTrack) return false;
  if (trigger === "option" && (!optionHeld || optionBlocked)) return false;
  return true;
}

function isCallActive() {
  const callPanel = document.querySelector("#call-panel");
  return Boolean(callPanel && !callPanel.hidden);
}

async function persistChunk(state, blob) {
  const sequence = state.draft.sequence;
  state.draft.sequence += 1;
  state.draft.totalBytes += blob.size;
  state.draft.lastChunkAt = Date.now();
  try {
    await appendVoiceChunk(state.draft.id, sequence, blob);
    await updateVoiceDraft(state.draft.id, {
      sequence: state.draft.sequence,
      totalBytes: state.draft.totalBytes,
      lastChunkAt: state.draft.lastChunkAt
    });
  } catch (error) {
    await interruptRecording(`Не удалось сохранить продолжение записи: ${error.message}`);
    return;
  }

  if (state.draft.totalBytes >= LOCAL_PART_SIZE) {
    state.uploadQueue = state.uploadQueue.then(() => uploadReadyFullParts(state)).catch(() => undefined);
  }
}

async function stopAndSend() {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "send";
  state.finishing = true;
  setRecordingUi(false);
  announce("Запись остановлена. Подготавливаю отправку голосового.");
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

async function cancelRecording() {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "cancel";
  state.finishing = true;
  setRecordingUi(false);
  announce("Останавливаю и отменяю запись голосового.");
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

async function interruptRecording(reason) {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "interrupted";
  state.draft.interruptionReason = reason;
  state.finishing = true;
  setRecordingUi(false);
  announce(`${reason} Записанная часть будет сохранена и не отправится автоматически.`);
  if (state.recorder.state !== "inactive") state.recorder.stop();
  state.stream.getTracks().forEach((track) => track.stop());
}

async function finishStoppedRecorder(state) {
  if (current !== state && !state.finishing) return;
  state.stream.getTracks().forEach((track) => track.stop());
  await state.dataQueue.catch(() => undefined);
  await state.uploadQueue.catch(() => undefined);
  const durationMs = Math.max(1, state.draft.lastChunkAt - state.draft.startedAt);
  const mode = state.stopMode ?? "interrupted";
  if (current === state) current = null;

  if (mode === "cancel") {
    state.transport?.close();
    await abortRemoteUpload(state.draft);
    await deleteVoiceDraft(state.draft.id).catch(() => undefined);
    await playVoiceCue("cancel");
    announce("Запись голосового отменена.");
  } else if (mode === "interrupted") {
    state.transport?.close();
    await abortRemoteUpload(state.draft);
    await updateVoiceDraft(state.draft.id, {
      state: "interrupted",
      durationMs,
      upload: null,
      interruptionReason: state.draft.interruptionReason ?? "Запись была прервана системой."
    }).catch(() => undefined);
    await playVoiceCue("error");
    announce(`${state.draft.interruptionReason ?? "Запись была прервана."} Записанная часть сохранена и не отправлена.`);
  } else {
    await updateVoiceDraft(state.draft.id, { state: "stopped", durationMs }).catch(() => undefined);
    await playVoiceCue("stop");
    await sendDraftById(state.draft.id, state.transport);
  }

  await refreshRecoverableDraft();
}

async function sendDraftById(id, existingTransport = null) {
  const draft = await getVoiceDraft(id);
  if (!draft) return;
  let transport = existingTransport;
  try {
    const totalBytes = Number(draft.totalBytes ?? 0);
    if (!totalBytes) throw new Error("запись пустая");

    const upload = await ensureDraftUpload(draft);
    const partSize = upload.chunkSizeBytes || LOCAL_PART_SIZE;
    const partCount = Math.ceil(totalBytes / partSize);
    const parts = [...(upload.parts ?? [])];

    if (upload.state !== "ready") {
      if (!transport || transport.sessionId !== upload.sessionId) {
        transport?.close();
        transport = new VoiceUploadSocket(draft.conversationId, upload.sessionId);
      }
      await transport.connect();
      for (const partNumber of transport.receivedParts) {
        if (!parts.some((part) => part.partNumber === partNumber)) parts.push({ partNumber });
      }
      parts.sort((left, right) => left.partNumber - right.partNumber);

      for (let index = 0; index < partCount; index += 1) {
        const partNumber = index + 1;
        if (parts.some((part) => part.partNumber === partNumber)) continue;
        const startByte = index * partSize;
        const body = await getVoicePartBlob(
          id,
          startByte,
          Math.min(partSize, totalBytes - startByte),
          draft.mimeType
        );
        if (!body.size) throw new Error(`не удалось прочитать часть ${partNumber} записи`);
        const ack = await transport.sendPart(partNumber, body);
        parts.push({ partNumber, sizeBytes: ack.sizeBytes });
        parts.sort((left, right) => left.partNumber - right.partNumber);
        upload.parts = parts;
        draft.upload = upload;
        await updateVoiceDraft(id, { upload });
      }
    }

    const result = await api(
      `/api/v1/chats/${draft.conversationId}/voice/uploads/${upload.sessionId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: draft.clientMessageId,
          durationMs: draft.durationMs ?? Math.max(1, draft.lastChunkAt - draft.startedAt),
          chunkCount: partCount,
          sizeBytes: totalBytes
        })
      }
    );
    await deleteVoiceDraft(id);
    recoverableDraft = null;
    hideDraftPanel();
    acceptExternalMessage(result.message);
    await refreshChatsAfterExternalMessage();
    announce("Голосовое сообщение отправлено.");
  } catch (error) {
    await updateVoiceDraft(id, { state: "failed", lastError: error.message }).catch(() => undefined);
    announce(`Голосовое не отправлено: ${error.message}. Запись сохранена, можно повторить.`);
    await playVoiceCue("error");
  } finally {
    transport?.close();
  }
}

async function ensureUploadSession(state) {
  if (state.draft.upload?.transport === "websocket") return state.draft.upload;
  if (state.uploadPromise) return state.uploadPromise;
  state.uploadPromise = ensureDraftUpload(state.draft)
    .then((upload) => {
      state.draft.upload = upload;
      return upload;
    })
    .finally(() => {
      state.uploadPromise = null;
    });
  return state.uploadPromise;
}

async function ensureDraftUpload(draft) {
  if (draft.upload?.transport === "websocket") {
    if (draft.state === "recording") return draft.upload;
    try {
      const status = await api(
        `/api/v1/chats/${draft.conversationId}/voice/uploads/${draft.upload.sessionId}`
      );
      const serverUpload = status.upload;
      const oldParts = new Map((draft.upload.parts ?? []).map((part) => [part.partNumber, part]));
      const upload = {
        ...draft.upload,
        ...serverUpload,
        transport: "websocket",
        parts: (serverUpload.receivedParts ?? []).map((partNumber) => oldParts.get(partNumber) ?? { partNumber })
      };
      await updateVoiceDraft(draft.id, { upload });
      draft.upload = upload;
      return upload;
    } catch (error) {
      if (error?.status !== 404 && error?.code !== "voice_upload_not_found") throw error;
      draft.upload = null;
      await updateVoiceDraft(draft.id, { upload: null });
    }
  }

  const result = await api(`/api/v1/chats/${draft.conversationId}/voice/uploads`, {
    method: "POST",
    body: JSON.stringify({ mimeType: draft.mimeType, bitrateBps: draft.bitrateBps })
  });
  const upload = {
    ...result.upload,
    transport: "websocket",
    parts: (result.upload.receivedParts ?? []).map((partNumber) => ({ partNumber }))
  };
  await updateVoiceDraft(draft.id, { upload });
  draft.upload = upload;
  return upload;
}

async function uploadReadyFullParts(state) {
  if (state.stopMode === "cancel" || state.stopMode === "interrupted") return;
  let upload;
  try {
    upload = await ensureUploadSession(state);
  } catch {
    return;
  }
  const partSize = upload.chunkSizeBytes || LOCAL_PART_SIZE;
  const fullPartCount = Math.floor(state.draft.totalBytes / partSize);
  if (!fullPartCount) return;

  try {
    state.transport ??= new VoiceUploadSocket(state.draft.conversationId, upload.sessionId);
    await state.transport.connect();
    for (const partNumber of state.transport.receivedParts) {
      if (!upload.parts.some((part) => part.partNumber === partNumber)) upload.parts.push({ partNumber });
    }
    upload.parts.sort((left, right) => left.partNumber - right.partNumber);

    for (let partNumber = 1; partNumber <= fullPartCount; partNumber += 1) {
      if (upload.parts.some((part) => part.partNumber === partNumber)) continue;
      const start = (partNumber - 1) * partSize;
      const body = await getVoicePartBlob(state.draft.id, start, partSize, state.draft.mimeType);
      if (body.size !== partSize) return;
      const ack = await state.transport.sendPart(partNumber, body);
      upload.parts.push({ partNumber, sizeBytes: ack.sizeBytes });
      upload.parts.sort((left, right) => left.partNumber - right.partNumber);
      state.draft.upload = upload;
      await updateVoiceDraft(state.draft.id, { upload });
    }
  } catch {
    state.transport?.close();
    state.transport = null;
  }
}

async function abortRemoteUpload(draft) {
  if (!draft.upload?.sessionId) return;
  try {
    await fetch(
      `/api/v1/chats/${draft.conversationId}/voice/uploads/${draft.upload.sessionId}`,
      { method: "DELETE", credentials: "same-origin" }
    );
  } catch {
    // Local draft remains the source of truth; server cleanup removes abandoned unfinished uploads.
  }
}

async function refreshRecoverableDraft() {
  if (starting || current) return;
  const account = getCurrentAccount();
  const chat = getSelectedChat();
  if (!account || !chat) {
    recoverableDraft = null;
    hideDraftPanel();
    return;
  }
  try {
    recoverableDraft = await findRecoverableVoiceDraft(account.userId, chat.conversationId);
  } catch {
    recoverableDraft = null;
  }
  if (!recoverableDraft) {
    hideDraftPanel();
    return;
  }
  draftPanel.hidden = false;
  const duration = formatDuration(recoverableDraft.durationMs ?? Math.max(0, recoverableDraft.lastChunkAt - recoverableDraft.startedAt));
  draftStatus.textContent = recoverableDraft.state === "interrupted"
    ? `Сохранена прерванная запись, ${duration}. Она не отправлена.`
    : `Сохранено неотправленное голосовое, ${duration}.`;
}

async function sendRecoverableDraft() {
  if (!recoverableDraft) return;
  draftSendButton.disabled = true;
  try {
    await sendDraftById(recoverableDraft.id);
  } finally {
    draftSendButton.disabled = false;
    await refreshRecoverableDraft();
  }
}

async function deleteRecoverableDraft() {
  if (!recoverableDraft) return;
  if (recoverableDraft.upload) await abortRemoteUpload(recoverableDraft);
  await deleteVoiceDraft(recoverableDraft.id);
  recoverableDraft = null;
  hideDraftPanel();
  announce("Сохранённая запись удалена.");
}

function hideDraftPanel() {
  if (draftPanel) draftPanel.hidden = true;
}

function setStartingUi(active) {
  if (!recordButton) return;
  recordButton.disabled = active;
  recordButton.setAttribute("aria-busy", String(active));
  if (active) {
    recordButton.textContent = "Подготавливаю запись";
    recordButton.setAttribute("aria-label", "Подготавливается запись голосового сообщения");
    return;
  }
  if (!current) setRecordingUi(false);
}

function setRecordingUi(recording, startedAt = current?.draft?.startedAt ?? Date.now()) {
  if (!recordButton) return;
  recordButton.textContent = recording ? "Отправить голосовое" : "Записать голосовое";
  recordButton.setAttribute("aria-pressed", String(recording));
  recordButton.setAttribute("aria-label", recording
    ? "Остановить и отправить голосовое. Запись идёт."
    : "Записать голосовое");
  document.body.classList.toggle("voice-recording", recording);
  clearInterval(recordingTimer);
  recordingTimer = null;
  if (!recordingStatus) return;
  recordingStatus.hidden = !recording;
  if (!recording) return;
  const update = () => {
    recordingStatus.textContent = `Запись ${formatClock(Date.now() - startedAt)}`;
  };
  update();
  recordingTimer = setInterval(update, 1000);
}

function handleOptionKeyDown(event) {
  if (event.key === "Escape" && current) {
    event.preventDefault();
    void cancelRecording();
    return;
  }
  if (!isMacLike()) return;

  if (event.key !== "Alt") {
    if (event.altKey || optionTimer || current?.trigger === "option") {
      optionBlocked = true;
      clearOptionTimer();
      if (current?.trigger === "option") void cancelRecording();
    }
    return;
  }

  optionHeld = true;
  void prepareVoiceCues();
  if (event.repeat || current || starting || isEditable(event.target)) return;
  optionBlocked = event.ctrlKey || event.metaKey || event.shiftKey;
  if (optionBlocked || !getSelectedChat()) return;
  clearOptionTimer();
  optionTimer = setTimeout(() => {
    optionTimer = null;
    if (!optionBlocked && optionHeld && !current && !starting) void startRecording("option");
  }, OPTION_HOLD_DELAY_MS);
}

function handleOptionKeyUp(event) {
  if (!isMacLike() || event.key !== "Alt") return;
  optionHeld = false;
  clearOptionTimer();
  const wasBlocked = optionBlocked;
  optionBlocked = false;
  if (!wasBlocked && current?.trigger === "option") void stopAndSend();
}

function clearOptionTimer() {
  clearTimeout(optionTimer);
  optionTimer = null;
}

function chooseOpusMimeType() {
  return MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null;
}

async function enforceRawCapture(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("микрофон не дал аудиодорожку");
  // Просим браузер отключить обработку дважды: и в getUserMedia, и на самой
  // дорожке. Если ОС/браузер всё равно оставляет её включённой, запись разрешена:
  // Bulbam не добавляет собственный DSP, но web-приложение не может обещать raw hardware capture.
  await track.applyConstraints({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }).catch(() => undefined);
}

function isEditable(target) {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isMacLike() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(platform);
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `voice_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} мин ${seconds} с` : `${seconds} с`;
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
