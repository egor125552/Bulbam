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

const LOCAL_PART_SIZE = 5 * 1024 * 1024;
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

  window.addEventListener("bulbam:chat-changed", () => void refreshRecoverableDraft());
  window.addEventListener("bulbam:account-changed", () => void refreshRecoverableDraft());
  window.addEventListener("online", () => void refreshRecoverableDraft());

  document.addEventListener("keydown", handleOptionKeyDown, true);
  document.addEventListener("keyup", handleOptionKeyUp, true);
  window.addEventListener("blur", () => {
    optionHeld = false;
    clearOptionTimer();
    if (current?.trigger === "option") void interruptRecording("Окно потеряло фокус во время записи.");
  });
}

async function toggleButtonRecording() {
  if (current) {
    await stopAndSend();
    return;
  }
  await startRecording("button");
}

async function startRecording(trigger) {
  const account = getCurrentAccount();
  const chat = getSelectedChat();
  if (!account || !chat || current) return;
  const callPanel = document.querySelector("#call-panel");
  if (callPanel && !callPanel.hidden) {
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
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    await enforceRawCapture(stream);
    if (trigger === "option" && (!optionHeld || optionBlocked)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
  } catch (error) {
    announce(`Не удалось включить микрофон без обработки: ${error.message}`);
    await playVoiceCue("error");
    stream?.getTracks().forEach((track) => track.stop());
    return;
  }

  const localId = randomId();
  const draft = {
    id: localId,
    accountId: account.userId,
    conversationId: chat.conversationId,
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
    announce(`Не удалось подготовить надёжное хранение записи: ${error.message}`);
    await playVoiceCue("error");
    return;
  }

  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: bitrateBps });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await deleteVoiceDraft(localId).catch(() => undefined);
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
    finishing: false
  };
  current = state;

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

  recorder.start(1000);
  void ensureUploadSession(state);
  setRecordingUi(true, draft.startedAt);
  await playVoiceCue("start");
  announce(trigger === "option"
    ? "Запись голосового началась. Отпусти Option, чтобы отправить. Escape отменяет запись."
    : "Запись голосового началась. Нажми кнопку ещё раз, чтобы отправить.");
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
  await playVoiceCue("stop");
  announce("Запись остановлена. Отправляю голосовое.");
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

async function cancelRecording() {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "cancel";
  state.finishing = true;
  setRecordingUi(false);
  await playVoiceCue("cancel");
  announce("Запись голосового отменена.");
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

async function interruptRecording(reason) {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "interrupted";
  state.draft.interruptionReason = reason;
  state.finishing = true;
  setRecordingUi(false);
  await playVoiceCue("error");
  announce(`${reason} Записанная часть сохранена и не будет отправлена автоматически.`);
  if (state.recorder.state !== "inactive") state.recorder.stop();
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
    await abortRemoteUpload(state.draft);
    await deleteVoiceDraft(state.draft.id).catch(() => undefined);
  } else if (mode === "interrupted") {
    await abortRemoteUpload(state.draft);
    await updateVoiceDraft(state.draft.id, {
      state: "interrupted",
      durationMs,
      upload: null,
      interruptionReason: state.draft.interruptionReason ?? "Запись была прервана системой."
    }).catch(() => undefined);
  } else {
    await updateVoiceDraft(state.draft.id, { state: "stopped", durationMs }).catch(() => undefined);
    await sendDraftById(state.draft.id);
  }

  await refreshRecoverableDraft();
}

async function sendDraftById(id) {
  const draft = await getVoiceDraft(id);
  if (!draft) return;
  try {
    const totalBytes = Number(draft.totalBytes ?? 0);
    if (!totalBytes) throw new Error("запись пустая");

    const upload = await ensureDraftUpload(draft);
    const parts = [...(upload.parts ?? [])];
    const partSize = upload.partSizeBytes || LOCAL_PART_SIZE;
    const partCount = Math.ceil(totalBytes / partSize);
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
      const part = await uploadPart(draft.conversationId, upload, partNumber, body);
      parts.push(part);
      parts.sort((left, right) => left.partNumber - right.partNumber);
      upload.parts = parts;
      draft.upload = upload;
      await updateVoiceDraft(id, { upload });
    }

    const result = await api(
      `/api/v1/chats/${draft.conversationId}/voice/uploads/${upload.sessionId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          uploadId: upload.uploadId,
          clientMessageId: draft.clientMessageId,
          durationMs: draft.durationMs ?? Math.max(1, draft.lastChunkAt - draft.startedAt),
          mimeType: draft.mimeType,
          bitrateBps: draft.bitrateBps,
          parts
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
  }
}

async function ensureUploadSession(state) {
  if (state.draft.upload) return state.draft.upload;
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
  if (draft.upload) return draft.upload;
  const result = await api(`/api/v1/chats/${draft.conversationId}/voice/uploads`, {
    method: "POST",
    body: JSON.stringify({ mimeType: draft.mimeType, bitrateBps: draft.bitrateBps })
  });
  const upload = { ...result.upload, parts: [] };
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
  const fullPartCount = Math.floor(state.draft.totalBytes / upload.partSizeBytes);
  for (let partNumber = 1; partNumber <= fullPartCount; partNumber += 1) {
    if (upload.parts.some((part) => part.partNumber === partNumber)) continue;
    const start = (partNumber - 1) * upload.partSizeBytes;
    const body = await getVoicePartBlob(
      state.draft.id,
      start,
      upload.partSizeBytes,
      state.draft.mimeType
    );
    if (body.size !== upload.partSizeBytes) return;
    const part = await uploadPart(state.draft.conversationId, upload, partNumber, body);
    upload.parts.push(part);
    upload.parts.sort((left, right) => left.partNumber - right.partNumber);
    state.draft.upload = upload;
    await updateVoiceDraft(state.draft.id, { upload });
  }
}

async function uploadPart(conversationId, upload, partNumber, body) {
  const response = await fetch(
    `/api/v1/chats/${conversationId}/voice/uploads/${upload.sessionId}/parts/${partNumber}?uploadId=${encodeURIComponent(upload.uploadId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/octet-stream" },
      body
    }
  );
  const payload = await safeJson(response);
  if (!response.ok) throw new Error(payload?.error?.message ?? `Ошибка загрузки HTTP ${response.status}`);
  return payload.part;
}

async function abortRemoteUpload(draft) {
  if (!draft.upload) return;
  try {
    await fetch(
      `/api/v1/chats/${draft.conversationId}/voice/uploads/${draft.upload.sessionId}?uploadId=${encodeURIComponent(draft.upload.uploadId)}`,
      { method: "DELETE", credentials: "same-origin" }
    );
  } catch {
    // Incomplete R2 multipart uploads expire automatically; local draft remains the source of truth here.
  }
}

async function refreshRecoverableDraft() {
  if (current) return;
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
  if (event.repeat || current || isEditable(event.target)) return;
  optionBlocked = event.ctrlKey || event.metaKey || event.shiftKey;
  if (optionBlocked || !getSelectedChat()) return;
  clearOptionTimer();
  optionTimer = setTimeout(() => {
    optionTimer = null;
    if (!optionBlocked && optionHeld && !current) void startRecording("option");
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
  await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }).catch(() => undefined);
  const settings = track.getSettings?.() ?? {};
  for (const key of ["echoCancellation", "noiseSuppression", "autoGainControl"]) {
    if (settings[key] === true) {
      throw new Error("браузер не отключил обработку микрофона");
    }
  }
}

function isEditable(target) {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isMacLike() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(platform);
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `voice_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
