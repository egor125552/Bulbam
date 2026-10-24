import { renderVoiceRecorderVisual, renderVoiceDeliveryVisual } from "./voice-recorder-visual.js";
import { rawVoiceConstraints, keepVoiceRaw } from "./voice-raw-capture.js";
import { logDiagnostic } from "./diagnostics-log.js";
import { explainMicrophoneError } from "./microphone-permissions.js";
import { isDetailedHelpEnabled } from "./accessibility-help.js";
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
import { createRecordingClock } from "./voice-recording-clock.js";

const LOCAL_PART_SIZE = 256 * 1024;
const OPTION_HOLD_DELAY_MS = 220;
const MIME_CANDIDATES = /android/i.test(navigator.userAgent)
  ? ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"]
  : ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"];

let recordButton = null;
let pauseButton = null;
let cancelButton = null;
let visualControls = null;
let deliveryVisual = null;
let deliveryHideTimer = null;
let detailedHelp = true;
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
  pauseButton = document.querySelector("#voice-pause-button");
  cancelButton = document.querySelector("#voice-cancel-button");
  deliveryVisual = document.querySelector("#voice-delivery-visual");
  visualControls = {
    body: document.body,
    panel: document.querySelector("#voice-recording-panel"),
    label: document.querySelector("#voice-recording-visual-label"),
    timer: document.querySelector("#voice-recording-visual-timer"),
    hint: document.querySelector("#voice-recording-visual-hint"),
    cancelButton,
    recordButton
  };
  detailedHelp = isDetailedHelpEnabled();
  window.addEventListener("bulbam:detailed-help-changed", (event) => {
    detailedHelp = event.detail?.enabled !== false;
    syncRecordingHelp();
  });
  syncRecordingHelp();
  draftPanel = document.querySelector("#voice-draft-panel");
  draftStatus = document.querySelector("#voice-draft-status");
  draftSendButton = document.querySelector("#voice-draft-send");
  draftDeleteButton = document.querySelector("#voice-draft-delete");
  recordingStatus = document.querySelector("#voice-recording-status");
  recordButton?.addEventListener("click", () => {
    void prepareVoiceCues();
    void toggleButtonRecording();
  });
  pauseButton?.addEventListener("click", () => togglePauseRecording());
  cancelButton?.addEventListener("click", () => void cancelRecording());
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
  showVoiceDelivery("");
  logDiagnostic("Голосовые", "запрос на запись");
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

    const mimeType = chooseVoiceMimeType();
    if (!mimeType) {
      announce("Браузер не умеет записывать совместимый формат голосовых сообщений.");
      await playVoiceCue("error");
      return;
    }

    const bitrateBps = getVoiceBitrate();
    logDiagnostic("Голосовые", "выбраны параметры", `${bitrateBps} бит в секунду`);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: rawVoiceConstraints(navigator.mediaDevices.getSupportedConstraints?.() ?? null)
      });
      const raw = await keepVoiceRaw(stream.getAudioTracks()[0]);
      logDiagnostic("Микрофон", "проверка исходного звука", raw.summary);
      logDiagnostic("Микрофон", raw.confirmed ? "обработка выключена" : "обработка не подтверждена");
    } catch (error) {
      announce(`Не удалось включить микрофон: ${explainMicrophoneError(error)}`);
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
      logDiagnostic("Голосовые", "черновик сохранён локально");
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
      announce(`Не удалось запустить запись голосового: ${error.message}`);
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
      finishing: false,
      clock: createRecordingClock(draft.startedAt)
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
      logDiagnostic("Голосовые", "кодировщик запущен");
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
    // Готовим серверную сессию и WebSocket, пока пользователь ещё говорит.
    // Поэтому после Stop короткому голосовому остаётся передать только сами байты.
    void prewarmUpload(state);
    setRecordingUi(true, draft.startedAt);
    if (trigger === "button") retainRecordFocus();
    announce(detailedHelp
      ? (trigger === "option"
          ? "Запись голосового началась. Отпусти Option, чтобы отправить. Escape отменяет запись."
          : "Запись голосового началась. Ещё раз нажмите «Отправить голосовое» для отправки, либо «Пауза записи».")
      : "Идёт запись.");
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
    logDiagnostic("Голосовые", "фрагмент сохранён", `${blob.size} байт`);
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

function syncRecordingHelp() {
  if (!recordButton) return;
  if (detailedHelp) recordButton.setAttribute("aria-describedby", "voice-record-hint");
  else recordButton.removeAttribute("aria-describedby");
}

function retainRecordFocus() {
  // Keep VoiceOver focused on the actual button after an async permission dialog
  // and label change, rather than sending the cursor back to the chat list.
  if (recordButton && !recordButton.hidden && document.activeElement !== recordButton) {
    recordButton.focus({ preventScroll: true });
  }
}

function togglePauseRecording() {
  const state = current;
  if (!state || state.finishing || state.trigger !== "button") return;
  if (typeof state.recorder.pause !== "function" || typeof state.recorder.resume !== "function") return;
  try {
    if (state.clock.paused) {
      state.recorder.resume();
      state.clock.resume();
      announce("Запись голосового продолжена.");
    } else {
      state.recorder.pause();
      state.clock.pause();
      announce("Запись голосового на паузе.");
    }
    syncPauseUi();
  } catch (error) {
    announce("Не удалось поставить запись на паузу: " + (error?.message ?? "ошибка микрофона"));
  }
}

function syncPauseUi() {
  if (!pauseButton) return;
  const state = current;
  const available = Boolean(state && !state.finishing && state.trigger === "button" &&
    typeof state.recorder.pause === "function" && typeof state.recorder.resume === "function");
  pauseButton.hidden = !available;
  if (!available) return;
  const paused = state.clock.paused;
  pauseButton.textContent = paused ? "Продолжить запись" : "Пауза записи";
  pauseButton.setAttribute("aria-label", paused ? "Продолжить запись голосового" : "Приостановить запись голосового");
  pauseButton.setAttribute("aria-pressed", String(paused));
  pauseButton.dataset.icon = paused ? "play" : "pause";
  if (recordingStatus && paused) recordingStatus.textContent = "Запись на паузе";
  updateVisualRecording();
}

async function stopAndSend() {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "send";
  logDiagnostic("Голосовые", "запись остановлена");
  state.finishing = true;
  setRecordingUi(false);
  showVoiceDelivery("Подготавливаю отправку голосового…");
  announce("Запись остановлена. Подготавливаю отправку голосового.");
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

async function cancelRecording() {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "cancel";
  logDiagnostic("Голосовые", "запись отменяется");
  state.finishing = true;
  setRecordingUi(false);
  showVoiceDelivery("Отменяю запись…");
  announce("Останавливаю и отменяю запись голосового.");
  if (state.recorder.state !== "inactive") state.recorder.stop();
}

async function interruptRecording(reason) {
  const state = current;
  if (!state || state.finishing) return;
  state.stopMode = "interrupted";
  logDiagnostic("Голосовые", "запись прервана");
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
  if (state.uploadPromise) await state.uploadPromise.catch(() => undefined);
  const durationMs = Math.max(1, state.clock.elapsed());
  const mode = state.stopMode ?? "interrupted";
  logDiagnostic("Голосовые", "кодировщик остановлен", `режим ${mode}`);
  if (current === state) current = null;

  if (mode === "cancel") {
    state.transport?.close();
    await abortRemoteUpload(state.draft);
    await deleteVoiceDraft(state.draft.id).catch(() => undefined);
    await playVoiceCue("cancel");
    showVoiceDelivery("Запись отменена.", "success", true);
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
    const stopCue = playVoiceCue("stop").catch(() => undefined);
    await sendDraftById(state.draft.id, state.transport);
    await stopCue;
  }

  await refreshRecoverableDraft();
}

async function sendDraftById(id, existingTransport = null) {
  const draft = await getVoiceDraft(id);
  if (!draft) return;
  let transport = existingTransport;
  try {
    showVoiceDelivery("Отправляю голосовое сообщение…");
    const totalBytes = Number(draft.totalBytes ?? 0);
    if (!totalBytes) throw new Error("запись пустая");

    logDiagnostic("Голосовые", "подготовка серверной загрузки");
    const upload = await ensureDraftUpload(draft);
    logDiagnostic("Голосовые", "сервер подтвердил загрузку");
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
        logDiagnostic("Голосовые", "сервер подтвердил фрагмент", `${partNumber} часть`);
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
    showVoiceDelivery("Голосовое сообщение отправлено.", "success", true);
    announce("Голосовое сообщение отправлено.");
  } catch (error) {
    await updateVoiceDraft(id, { state: "failed", lastError: error.message }).catch(() => undefined);
    showVoiceDelivery("Не удалось отправить. Запись сохранена, можно повторить.", "error");
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

async function prewarmUpload(state) {
  if (state.stopMode === "cancel" || state.stopMode === "interrupted") return;
  try {
    const upload = await ensureUploadSession(state);
    if (state.stopMode === "cancel" || state.stopMode === "interrupted") return;
    state.transport ??= new VoiceUploadSocket(state.draft.conversationId, upload.sessionId);
    await state.transport.connect();
  } catch {
    state.transport?.dropConnection();
    state.transport = null;
  }
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
  syncPauseUi();
}

function setRecordingUi(recording, startedAt = current?.draft?.startedAt ?? Date.now()) {
  if (!recordButton) return;
  syncPauseUi();
  renderVoiceRecorderVisual(visualControls, {
    recording,
    paused: current?.clock?.paused ?? false,
    elapsedMs: current?.clock?.elapsed() ?? Date.now() - startedAt
  });
  recordButton.textContent = recording ? "Отправить голосовое" : "Записать голосовое";
  recordButton.setAttribute("aria-pressed", String(recording));
  recordButton.setAttribute("aria-label", recording
    ? "Остановить и отправить голосовое. Запись идёт."
    : "Записать голосовое");
  document.body.classList.toggle("voice-recording", recording);
  window.dispatchEvent(new CustomEvent("bulbam:voice-recording-changed", { detail: {recording} }));
  clearInterval(recordingTimer);
  recordingTimer = null;
  if (!recordingStatus) return;
  recordingStatus.hidden = !recording;
  if (!recording) return;
  const update = () => {
    recordingStatus.textContent = current?.clock?.paused
      ? "Запись на паузе"
      : `Запись ${formatClock(current?.clock?.elapsed() ?? Date.now() - startedAt)}`;
    updateVisualRecording();
  };
  update();
  recordingTimer = setInterval(update, 1000);
}

function showVoiceDelivery(message, state = "progress", temporary = false) {
  clearTimeout(deliveryHideTimer);
  deliveryHideTimer = null;
  renderVoiceDeliveryVisual(deliveryVisual, message, state);
  if (temporary) {
    deliveryHideTimer = setTimeout(() => {
      renderVoiceDeliveryVisual(deliveryVisual, "");
      deliveryHideTimer = null;
    }, 5000);
  }
}

function updateVisualRecording() {
  if (!visualControls || !current || current.finishing) return;
  renderVoiceRecorderVisual(visualControls, {
    recording: true,
    paused: current.clock.paused,
    elapsedMs: current.clock.elapsed()
  });
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

function chooseVoiceMimeType() {
  return MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null;
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