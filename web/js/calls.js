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
let muted = false;
let iceServersPromise = null;

export function setupCalls() {
  elements.callStartButton.addEventListener("click", () => void startCall());
  elements.callAnswerButton.addEventListener("click", () => void answerCall());
  elements.callDeclineButton.addEventListener("click", () => void declineCall());
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
    const result = await api(`/api/v1/calls/${encodeURIComponent(currentCall.callId)}/answer`, {
      method: "POST"
    });
    currentCall = result.call;
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

async function declineCall() {
  if (!currentCall) return;
  elements.callDeclineButton.disabled = true;
  try {
    await api(`/api/v1/calls/${encodeURIComponent(currentCall.callId)}/decline`, { method: "POST" });
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
  const callId = currentCall.callId;
  elements.callEndButton.disabled = true;
  try {
    await api(`/api/v1/calls/${encodeURIComponent(callId)}/end`, { method: "POST" });
  } catch {
    // Local media must stop even if the network disappears while hanging up.
  } finally {
    finishCall("Звонок завершён.");
    announce("Звонок завершён.");
    elements.callEndButton.disabled = false;
  }
}

async function timeoutRinging() {
  if (!currentCall || currentCall.status !== "ringing" || currentCall.direction !== "outgoing") return;
  try {
    await api(`/api/v1/calls/${encodeURIComponent(currentCall.callId)}/end`, { method: "POST" });
  } catch {}
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

  if (event.type === "call.ringing" && event.call) {
    if (!currentCall) {
      currentCall = event.call;
      answeredLocally = false;
      offerStarted = false;
      showIncoming(currentCall);
      startCallPolling();
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
      showConnectedControls("Ответ получен. Соединяю звук…");
      await beginOfferIfNeeded();
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
    await processSignal(event.signal);
  }
}

async function beginOfferIfNeeded() {
  if (!currentCall || currentCall.direction !== "outgoing" || offerStarted) return;
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
      setCallStatus("Не удалось провести аудио через эту сеть. Для такой сети может потребоваться TURN.");
    }
  });

  return pc;
}

async function sendSignal(kind, payload) {
  if (!currentCall) return;
  const result = await api(`/api/v1/calls/${encodeURIComponent(currentCall.callId)}/signals`, {
    method: "POST",
    body: JSON.stringify({ kind, payload })
  });
  if (result.signal?.sequence) processedSignalSequences.add(result.signal.sequence);
}

async function processSignal(signal) {
  if (!currentCall || signal.callId !== currentCall.callId) return;
  if (signal.senderUserId === account?.userId) return;
  if (processedSignalSequences.has(signal.sequence)) return;
  processedSignalSequences.add(signal.sequence);

  try {
    const pc = await ensurePeerConnection();
    if (signal.kind === "offer") {
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

function stopCallPolling() {
  clearInterval(signalPollTimer);
  clearInterval(statePollTimer);
  signalPollTimer = null;
  statePollTimer = null;
}

async function pollSignals() {
  if (!currentCall || currentCall.status !== "accepted") return;
  try {
    const result = await api(
      `/api/v1/calls/${encodeURIComponent(currentCall.callId)}/signals?after=${signalPollCursor}`
    );
    for (const signal of result.signals ?? []) {
      await processSignal(signal);
      signalPollCursor = Math.max(signalPollCursor, Number(signal.sequence) || 0);
    }
  } catch {}
}

async function pollCallState() {
  if (!currentCall) return;
  try {
    const result = await api(`/api/v1/calls/${encodeURIComponent(currentCall.callId)}`);
    const latest = result.call;
    if (!latest) return;

    if (latest.status === "accepted" && currentCall.status === "ringing") {
      currentCall = latest;
      clearTimeout(ringTimeout);
      ringTimeout = null;
      if (latest.direction === "outgoing") {
        showConnectedControls("Ответ получен. Соединяю звук…");
        await beginOfferIfNeeded();
      } else if (!answeredLocally) {
        finishCall("На звонок ответили на другом устройстве.");
      }
      return;
    }

    currentCall = { ...currentCall, ...latest };
    if (latest.status === "declined") {
      finishCall("Собеседник отклонил звонок.");
    } else if (latest.status === "ended") {
      finishCall("Звонок завершён.");
    }
  } catch {}
}

async function restoreCallFromUrl() {
  const url = new URL(location.href);
  const callId = url.searchParams.get("call");
  if (!callId || !account) return;
  url.searchParams.delete("call");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

  try {
    const result = await api(`/api/v1/calls/${encodeURIComponent(callId)}`);
    if (result.call?.direction === "incoming" && result.call.status === "ringing") {
      currentCall = result.call;
      answeredLocally = false;
      showIncoming(currentCall);
      startCallPolling();
      elements.callTitle.focus();
      announce(`Входящий звонок от ${currentCall.peer.displayName}.`);
    } else if (result.call?.status === "ringing") {
      currentCall = result.call;
      showOutgoing(currentCall);
      startCallPolling();
    } else {
      renderFinished("Этот звонок уже завершён или на него уже ответили.");
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

function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("этот браузер не предоставляет доступ к микрофону");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
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
  elements.callMuteButton.hidden = false;
  elements.callEndButton.hidden = false;
  syncCallButton();
}

function finishCall(message) {
  cleanupMedia();
  currentCall = null;
  answeredLocally = false;
  offerStarted = false;
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
  elements.callMuteButton.hidden = true;
  elements.callEndButton.hidden = true;
}

function renderIdle() {
  elements.callPanel.hidden = true;
  elements.callPeer.textContent = "";
  elements.callStatus.textContent = "Звонок не активен.";
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callMuteButton.hidden = true;
  elements.callEndButton.hidden = true;
}

function setCallStatus(text) {
  elements.callStatus.textContent = text;
}

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
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
  }
  localStream = null;
}

function resetCallRuntime() {
  clearTimeout(ringTimeout);
  stopCallPolling();
  cleanupPeerConnection();
  stopLocalStream();
  processedSignalSequences = new Set();
  signalPollCursor = 0;
  answeredLocally = false;
  offerStarted = false;
  muted = false;
}

function friendlyMediaError(error) {
  if (error?.name === "NotAllowedError") return "нет разрешения на микрофон";
  if (error?.name === "NotFoundError") return "микрофон не найден";
  return error?.message ?? "неизвестная ошибка";
}
