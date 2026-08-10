import { api } from "./api.js";
import { announce, elements, getCurrentAccount } from "./ui.js";

let account = null;
let currentCall = null;
let localStream = null;
let peerConnection = null;
let remoteCandidates = [];
let processedSignalSequences = new Set();
let signalPollCursor = 0;
let signalPollTimer = null;
let statePollTimer = null;
let ringTimeout = null;
let callSocket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let answeredLocally = false;
let offerStarted = false;
let restartInFlight = false;
let recoveryPending = false;
let muted = false;
let iceServersPromise = null;

export function setupCalls() {
  elements.callStartButton.addEventListener("click", () => void startCall());
  elements.callAnswerButton.addEventListener("click", () => void answerCall());
  elements.callDeclineButton.addEventListener("click", () => void declineCall());
  elements.callResumeButton.addEventListener("click", () => void resumeRecoveredCall());
  elements.callEndButton.addEventListener("click", () => void endCall());
  elements.callMuteButton.addEventListener("click", toggleMute);

  const observer = new MutationObserver(syncCallButton);
  observer.observe(elements.conversationPeer, { childList: true, characterData: true, subtree: true });
  observer.observe(elements.messageForm, { attributes: true, attributeFilter: ["hidden"] });

  window.addEventListener("bulbam:account-changed", (event) => {
    void switchAccount(event.detail?.account ?? null);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && account && !callSocket) connectCallRealtime();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "bulbam.call-push") {
        void handleVisibleCallPush(event.data.data ?? {});
      }
    });
  }
}

async function switchAccount(nextAccount) {
  if (currentCall) cleanupMedia();
  account = nextAccount;
  currentCall = null;
  resetCallRuntime();
  closeCallRealtime();
  renderIdle();
  syncCallButton();
  if (!account) return;
  connectCallRealtime();
  await restoreCallFromUrl();
}

async function handleVisibleCallPush(data) {
  if (!account || currentCall) return;
  const callId = typeof data?.callId === "string" ? data.callId : "";
  const conversationId = typeof data?.conversationId === "string" ? data.conversationId : "";
  if (!callId || !conversationId) return;

  try {
    const result = await api(
      `/api/v1/chats/${encodeURIComponent(conversationId)}/calls/${encodeURIComponent(callId)}`
    );
    if (!result.call || currentCall) return;
    currentCall = result.call;
    answeredLocally = false;
    offerStarted = false;

    if (currentCall.direction === "incoming" && currentCall.status === "ringing") {
      recoveryPending = false;
      showIncoming(currentCall);
      startStatePolling();
      announce(`Входящий звонок от ${currentCall.peer.displayName}.`);
      return;
    }

    if (currentCall.status === "ringing" || currentCall.status === "accepted") {
      recoveryPending = true;
      showRecoveredCall("Активный звонок найден. Нажмите «Восстановить звук».");
      startStatePolling();
    } else {
      currentCall = null;
    }
  } catch {
    // Realtime may have already delivered or the short-lived call may have ended.
  }
}

async function startCall() {
  if (!account || currentCall) return;
  const chat = await selectedChatFromUi();
  if (!chat) {
    announce("Сначала откройте личный чат.");
    return;
  }

  elements.callStartButton.disabled = true;
  try {
    localStream = await requestMicrophone();
    const result = await api(`/api/v1/chats/${encodeURIComponent(chat.conversationId)}/calls`, {
      method: "POST"
    });
    currentCall = result.call;
    answeredLocally = false;
    offerStarted = false;
    recoveryPending = false;
    showOutgoing(currentCall);
    startCallPolling();
    ringTimeout = setTimeout(() => void timeoutRinging(), 60_000);
    announce(`Звоним ${currentCall.peer.displayName}.`);
  } catch (error) {
    stopLocalStream();
    announce(`Не удалось начать звонок: ${friendlyMediaError(error)}`);
  } finally {
    elements.callStartButton.disabled = false;
    syncCallButton();
  }
}

async function answerCall() {
  if (!account || !currentCall || currentCall.status !== "ringing" || currentCall.direction !== "incoming") return;
  elements.callAnswerButton.disabled = true;
  answeredLocally = true;
  try {
    localStream = await requestMicrophone();
    await ensurePeerConnection();
    const result = await api(callPath("/answer"), { method: "POST" });
    currentCall = result.call;
    recoveryPending = false;
    showConnectedControls("Соединяем звонок…");
    startCallPolling();
    announce(`Вы ответили ${currentCall.peer.displayName}. Соединяю звук.`);
  } catch (error) {
    answeredLocally = false;
    cleanupPeerConnection();
    stopLocalStream();
    elements.callAnswerButton.hidden = false;
    elements.callDeclineButton.hidden = false;
    setCallStatus(`Не удалось ответить: ${friendlyMediaError(error)}`);
    announce(`Не удалось ответить: ${friendlyMediaError(error)}`);
  } finally {
    elements.callAnswerButton.disabled = false;
  }
}

async function resumeRecoveredCall() {
  if (!account || !currentCall || !recoveryPending) return;
  elements.callResumeButton.disabled = true;
  try {
    localStream = await requestMicrophone();
    await prepareRecoveryCursor();
    cleanupPeerConnection();
    remoteCandidates = [];
    offerStarted = false;
    recoveryPending = false;

    if (currentCall.status === "accepted") {
      showConnectedControls("Восстанавливаю аудиосоединение…");
      startCallPolling();
      if (currentCall.direction === "outgoing") {
        await restartOffer();
      } else {
        await sendSignal("resume", { reason: "client-reconnect" });
      }
    } else if (currentCall.status === "ringing" && currentCall.direction === "outgoing") {
      showOutgoing(currentCall);
      startCallPolling();
    } else {
      showIncoming(currentCall);
      startStatePolling();
    }

    announce(`Звук звонка с ${currentCall.peer.displayName} восстанавливается.`);
  } catch (error) {
    recoveryPending = true;
    showRecoveredCall(`Не удалось восстановить звук: ${friendlyMediaError(error)}`);
    announce(`Не удалось восстановить звук: ${friendlyMediaError(error)}`);
  } finally {
    elements.callResumeButton.disabled = false;
  }
}

async function declineCall() {
  if (!currentCall) return;
  elements.callDeclineButton.disabled = true;
  try {
    await api(callPath("/decline"), { method: "POST" });
    finishCall("Звонок отклонён.");
    announce("Звонок отклонён.");
  } catch (error) {
    setCallStatus(`Не удалось отклонить звонок: ${error.message}`);
  } finally {
    elements.callDeclineButton.disabled = false;
  }
}

async function endCall() {
  if (!currentCall) return;
  elements.callEndButton.disabled = true;
  try {
    await api(callPath("/end"), { method: "POST" });
  } catch {
    // Локальный микрофон всё равно выключаем даже при обрыве сети.
  } finally {
    finishCall("Звонок завершён.");
    announce("Звонок завершён.");
    elements.callEndButton.disabled = false;
  }
}

async function timeoutRinging() {
  if (!currentCall || currentCall.status !== "ringing" || currentCall.direction !== "outgoing") return;
  try { await api(callPath("/end"), { method: "POST" }); } catch {}
  finishCall("Нет ответа.");
  announce("На звонок не ответили.");
}

async function selectedChatFromUi() {
  if (elements.messageForm.hidden) return null;
  const peerText = elements.conversationPeer.textContent.trim();
  if (!peerText.startsWith("@")) return null;
  const username = peerText.slice(1);
  const result = await api("/api/v1/chats");
  return (result.chats ?? []).find((chat) => chat.peer?.username === username) ?? null;
}

function connectCallRealtime() {
  if (!account || callSocket?.readyState === WebSocket.OPEN || callSocket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  callSocket = new WebSocket(`${protocol}//${location.host}/api/v1/realtime`);

  callSocket.addEventListener("open", () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (callSocket?.readyState === WebSocket.OPEN) callSocket.send("ping");
    }, 25_000);
  });
  callSocket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(String(event.data)); } catch { return; }
    void handleCallEvent(payload);
  });
  callSocket.addEventListener("close", () => {
    callSocket = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (!account) return;
    reconnectTimer = setTimeout(connectCallRealtime, 2_000);
  });
  callSocket.addEventListener("error", () => {
    try { callSocket?.close(); } catch {}
  });
}

function closeCallRealtime() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
  if (callSocket) {
    try { callSocket.close(); } catch {}
  }
  callSocket = null;
}

async function handleCallEvent(event) {
  if (!account || !event || typeof event !== "object") return;

  if (event.type === "call.active" && event.call) {
    if (currentCall) return;
    currentCall = event.call;
    answeredLocally = false;
    offerStarted = false;
    if (currentCall.status === "ringing" && currentCall.direction === "incoming") {
      recoveryPending = false;
      showIncoming(currentCall);
      startStatePolling();
      announce(`Входящий звонок от ${currentCall.peer.displayName}.`);
    } else if (currentCall.status === "ringing" || currentCall.status === "accepted") {
      recoveryPending = true;
      showRecoveredCall(
        currentCall.status === "accepted"
          ? "Активный звонок найден после переподключения. Нажмите «Восстановить звук»."
          : "Исходящий звонок продолжается. Нажмите «Восстановить звук»."
      );
      startStatePolling();
      announce(`Активный звонок с ${currentCall.peer.displayName} найден.`);
    } else {
      currentCall = null;
      renderIdle();
    }
    return;
  }

  if (event.type === "call.ringing" && event.call) {
    if (!currentCall) {
      currentCall = event.call;
      answeredLocally = false;
      offerStarted = false;
      recoveryPending = false;
      showIncoming(currentCall);
      startStatePolling();
      announce(`Входящий звонок от ${currentCall.peer.displayName}.`);
    }
    return;
  }

  if (!currentCall || event.callId !== currentCall.callId) return;

  if (event.type === "call.answered") {
    currentCall.status = "accepted";
    currentCall.answeredAt = event.answeredAt ?? Date.now();
    clearTimeout(ringTimeout);
    ringTimeout = null;
    if (currentCall.direction === "outgoing") {
      if (recoveryPending || !localStream) {
        recoveryPending = true;
        showRecoveredCall("Собеседник ответил. Нажмите «Восстановить звук».");
        startStatePolling();
      } else {
        showConnectedControls("Ответ получен. Соединяю звук…");
        await beginOfferIfNeeded();
      }
    } else if (!answeredLocally) {
      finishCall("На звонок ответили на другом устройстве.");
    }
    return;
  }

  if (event.type === "call.declined") {
    finishCall("Собеседник отклонил звонок.");
    announce("Собеседник отклонил звонок.");
    return;
  }
  if (event.type === "call.ended") {
    finishCall("Звонок завершён.");
    announce("Звонок завершён.");
    return;
  }
  if (event.type === "call.signal" && event.signal) {
    if (recoveryPending) return;
    await processSignal(event.signal);
  }
}

async function beginOfferIfNeeded() {
  if (!currentCall || currentCall.direction !== "outgoing" || offerStarted || recoveryPending) return;
  offerStarted = true;
  try {
    const pc = await ensurePeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal("offer", { type: offer.type, sdp: offer.sdp });
  } catch (error) {
    offerStarted = false;
    setCallStatus(`Не удалось создать аудиосоединение: ${error.message}`);
  }
}

async function restartOffer() {
  if (!currentCall || currentCall.direction !== "outgoing" || currentCall.status !== "accepted") return;
  if (restartInFlight) return;
  restartInFlight = true;
  try {
    cleanupPeerConnection();
    remoteCandidates = [];
    const pc = await ensurePeerConnection();
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    offerStarted = true;
    await sendSignal("offer", { type: offer.type, sdp: offer.sdp });
    setCallStatus("Восстанавливаю аудиосоединение…");
  } catch (error) {
    offerStarted = false;
    setCallStatus(`Не удалось восстановить аудиосоединение: ${error.message}`);
  } finally {
    restartInFlight = false;
  }
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  if (!localStream) localStream = await requestMicrophone();
  const iceServers = await getIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  peerConnection = pc;
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate || !currentCall) return;
    const candidate = event.candidate;
    void sendSignal("ice", {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment ?? null
    });
  });
  pc.addEventListener("track", (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    elements.callRemoteAudio.srcObject = stream;
    void elements.callRemoteAudio.play().catch(() => {
      setCallStatus("Звук подключён, но браузер заблокировал автоматическое воспроизведение.");
    });
  });
  pc.addEventListener("connectionstatechange", () => {
    if (peerConnection !== pc) return;
    if (pc.connectionState === "connected") {
      setCallStatus("Разговор идёт.");
      announce(`Аудиозвонок с ${currentCall?.peer?.displayName ?? "собеседником"} соединён.`);
    } else if (pc.connectionState === "connecting") {
      setCallStatus("Соединяю аудио…");
    } else if (pc.connectionState === "failed") {
      setCallStatus("Не удалось провести аудио через эту сеть. Проверяю доступные STUN/TURN маршруты.");
    }
  });
  return pc;
}

async function sendSignal(kind, payload) {
  if (!currentCall) return;
  const result = await api(callPath("/signals"), {
    method: "POST",
    body: JSON.stringify({ kind, payload })
  });
  if (result.signal?.sequence) processedSignalSequences.add(result.signal.sequence);
}

async function prepareRecoveryCursor() {
  if (!currentCall || currentCall.status !== "accepted") return;
  try {
    const result = await api(`${callPath("/signals")}?after=0`);
    for (const signal of result.signals ?? []) {
      const sequence = Number(signal.sequence) || 0;
      if (sequence > 0) processedSignalSequences.add(sequence);
      signalPollCursor = Math.max(signalPollCursor, sequence);
    }
  } catch {
    // Resume itself still creates a fresh negotiation if history lookup fails.
  }
}

async function processSignal(signal) {
  if (!currentCall || signal.callId !== currentCall.callId) return;
  if (signal.senderUserId === account?.userId || processedSignalSequences.has(signal.sequence)) return;
  processedSignalSequences.add(signal.sequence);

  try {
    if (signal.kind === "resume") {
      if (currentCall.direction === "outgoing" && !recoveryPending) {
        await restartOffer();
      }
      return;
    }

    let pc = await ensurePeerConnection();
    if (signal.kind === "offer") {
      if (pc.signalingState !== "stable") {
        cleanupPeerConnection();
        pc = await ensurePeerConnection();
      }
      await pc.setRemoteDescription(signal.payload);
      await flushRemoteCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal("answer", { type: answer.type, sdp: answer.sdp });
      showConnectedControls("Соединяю аудио…");
      return;
    }
    if (signal.kind === "answer") {
      await pc.setRemoteDescription(signal.payload);
      await flushRemoteCandidates();
      return;
    }
    if (signal.kind === "ice") {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.payload);
      else remoteCandidates.push(signal.payload);
    }
  } catch (error) {
    setCallStatus(`Ошибка WebRTC: ${error.message}`);
  }
}

async function flushRemoteCandidates() {
  if (!peerConnection?.remoteDescription) return;
  const queued = remoteCandidates;
  remoteCandidates = [];
  for (const candidate of queued) {
    try { await peerConnection.addIceCandidate(candidate); } catch {}
  }
}

function startCallPolling() {
  stopCallPolling();
  if (!currentCall) return;
  signalPollTimer = setInterval(() => void pollSignals(), 1_500);
  statePollTimer = setInterval(() => void pollCallState(), 2_500);
  void pollSignals();
  void pollCallState();
}

function startStatePolling() {
  clearInterval(statePollTimer);
  statePollTimer = setInterval(() => void pollCallState(), 2_500);
  void pollCallState();
}

function stopCallPolling() {
  clearInterval(signalPollTimer);
  clearInterval(statePollTimer);
  signalPollTimer = null;
  statePollTimer = null;
}

async function pollSignals() {
  if (!currentCall || currentCall.status !== "accepted" || recoveryPending) return;
  try {
    const result = await api(`${callPath("/signals")}?after=${signalPollCursor}`);
    for (const signal of result.signals ?? []) {
      await processSignal(signal);
      signalPollCursor = Math.max(signalPollCursor, Number(signal.sequence) || 0);
    }
  } catch {}
}

async function pollCallState() {
  if (!currentCall) return;
  try {
    const result = await api(callPath());
    const latest = result.call;
    if (!latest) return;
    if (latest.status === "accepted" && currentCall.status === "ringing") {
      currentCall = latest;
      clearTimeout(ringTimeout);
      ringTimeout = null;
      if (latest.direction === "outgoing") {
        if (recoveryPending || !localStream) {
          recoveryPending = true;
          showRecoveredCall("Собеседник ответил. Нажмите «Восстановить звук».");
          startStatePolling();
        } else {
          showConnectedControls("Ответ получен. Соединяю звук…");
          await beginOfferIfNeeded();
        }
      } else if (!answeredLocally) {
        finishCall("На звонок ответили на другом устройстве.");
      }
      return;
    }
    currentCall = { ...currentCall, ...latest };
    if (latest.status === "declined") finishCall("Собеседник отклонил звонок.");
    else if (latest.status === "ended") finishCall("Звонок завершён.");
  } catch {}
}

async function restoreCallFromUrl() {
  const url = new URL(location.href);
  const callId = url.searchParams.get("call");
  const conversationId = url.searchParams.get("chat");
  if (!callId || !conversationId || !account) return;
  url.searchParams.delete("call");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    const result = await api(
      `/api/v1/chats/${encodeURIComponent(conversationId)}/calls/${encodeURIComponent(callId)}`
    );
    currentCall = result.call;
    if (currentCall?.direction === "incoming" && currentCall.status === "ringing") {
      recoveryPending = false;
      showIncoming(currentCall);
      startStatePolling();
      elements.callTitle.focus();
      announce(`Входящий звонок от ${currentCall.peer.displayName}.`);
    } else if (currentCall?.status === "ringing" || currentCall?.status === "accepted") {
      recoveryPending = true;
      showRecoveredCall(
        currentCall.status === "accepted"
          ? "Активный звонок открыт. Нажмите «Восстановить звук»."
          : "Исходящий звонок открыт. Нажмите «Восстановить звук»."
      );
      startStatePolling();
      elements.callTitle.focus();
    } else {
      currentCall = null;
      renderFinished("Этот звонок уже завершён.");
    }
  } catch (error) {
    announce(`Не удалось открыть звонок: ${error.message}`);
  }
}

async function getIceServers() {
  iceServersPromise = iceServersPromise ?? api("/api/v1/calls/ice")
    .then((result) => result.iceServers ?? [])
    .catch(() => [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  return iceServersPromise;
}

function callPath(suffix = "") {
  if (!currentCall?.conversationId || !currentCall?.callId) throw new Error("Звонок ещё не создан.");
  return `/api/v1/chats/${encodeURIComponent(currentCall.conversationId)}/calls/${encodeURIComponent(currentCall.callId)}${suffix}`;
}

function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("этот браузер не предоставляет доступ к микрофону");
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
}

function showIncoming(call) {
  elements.callPanel.hidden = false;
  elements.callTitle.textContent = "Входящий звонок";
  elements.callPeer.textContent = `${call.peer.displayName}, @${call.peer.username}`;
  setCallStatus("Входящий аудиозвонок.");
  elements.callAnswerButton.hidden = false;
  elements.callDeclineButton.hidden = false;
  elements.callResumeButton.hidden = true;
  elements.callMuteButton.hidden = true;
  elements.callEndButton.hidden = true;
  syncCallButton();
}

function showOutgoing(call) {
  elements.callPanel.hidden = false;
  elements.callTitle.textContent = "Исходящий звонок";
  elements.callPeer.textContent = `${call.peer.displayName}, @${call.peer.username}`;
  setCallStatus("Ожидаю ответа…");
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callMuteButton.hidden = false;
  elements.callEndButton.hidden = false;
  syncCallButton();
}

function showConnectedControls(status) {
  elements.callPanel.hidden = false;
  elements.callTitle.textContent = "Аудиозвонок";
  setCallStatus(status);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callMuteButton.hidden = false;
  elements.callEndButton.hidden = false;
  syncCallButton();
}

function showRecoveredCall(status) {
  if (!currentCall) return;
  elements.callPanel.hidden = false;
  elements.callTitle.textContent = "Активный звонок";
  elements.callPeer.textContent = `${currentCall.peer.displayName}, @${currentCall.peer.username}`;
  setCallStatus(status);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = false;
  elements.callMuteButton.hidden = true;
  elements.callEndButton.hidden = false;
  syncCallButton();
}

function finishCall(message) {
  cleanupMedia();
  currentCall = null;
  answeredLocally = false;
  offerStarted = false;
  recoveryPending = false;
  renderFinished(message);
  syncCallButton();
}

function renderFinished(message) {
  elements.callPanel.hidden = false;
  elements.callTitle.textContent = "Звонок";
  elements.callPeer.textContent = "";
  setCallStatus(message);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callMuteButton.hidden = true;
  elements.callEndButton.hidden = true;
}

function renderIdle() {
  elements.callPanel.hidden = true;
  elements.callPeer.textContent = "";
  elements.callStatus.textContent = "Звонок не активен.";
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callMuteButton.hidden = true;
  elements.callEndButton.hidden = true;
}

function setCallStatus(text) { elements.callStatus.textContent = text; }

function syncCallButton() {
  const chatSelected = Boolean(account) && !elements.messageForm.hidden && elements.conversationPeer.textContent.trim().startsWith("@");
  elements.callStartButton.hidden = !chatSelected || Boolean(currentCall);
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  for (const track of localStream.getAudioTracks()) track.enabled = !muted;
  elements.callMuteButton.textContent = muted ? "Включить микрофон" : "Выключить микрофон";
  announce(muted ? "Микрофон выключен." : "Микрофон включён.");
}

function cleanupMedia() {
  clearTimeout(ringTimeout);
  ringTimeout = null;
  stopCallPolling();
  cleanupPeerConnection();
  stopLocalStream();
  processedSignalSequences = new Set();
  signalPollCursor = 0;
  remoteCandidates = [];
  muted = false;
  restartInFlight = false;
  iceServersPromise = null;
  elements.callMuteButton.textContent = "Выключить микрофон";
  elements.callRemoteAudio.srcObject = null;
}

function cleanupPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch {}
  }
  peerConnection = null;
  remoteCandidates = [];
}

function stopLocalStream() {
  if (localStream) for (const track of localStream.getTracks()) track.stop();
  localStream = null;
}

function resetCallRuntime() {
  clearTimeout(ringTimeout);
  ringTimeout = null;
  stopCallPolling();
  cleanupPeerConnection();
  stopLocalStream();
  processedSignalSequences = new Set();
  signalPollCursor = 0;
  answeredLocally = false;
  offerStarted = false;
  restartInFlight = false;
  recoveryPending = false;
  muted = false;
  iceServersPromise = null;
}

function friendlyMediaError(error) {
  if (error?.name === "NotAllowedError") return "нет разрешения на микрофон";
  if (error?.name === "NotFoundError") return "микрофон не найден";
  return error?.message ?? "неизвестная ошибка";
}
