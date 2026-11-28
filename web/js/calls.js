import { prepareRingback, startRingback, stopRingback, resetRingbackAudio } from "./call-ringback.js";
import { prepareCallCues, playCallCue, stopCallCues, resetCallCueAudio } from "./call-cues.js";
import { startCallTrace, logCallEvent } from "./call-event-log.js";
import { callProfiler, formatCallProfileCompact } from "./call-profiler.js";
import { createCallConnectionWatchdog } from "./call-connection-watchdog.js";
import { createRecoveryGate } from "./call-recovery-gate.js";
import { createCallHeadsetControls } from "./call-headset-controls.js";
import { switchCallAudioProfile, mediaErrorCategory } from "./call-audio-switch.js";
import { logDiagnostic, diagnosticErrorName, logTraceEvent } from "./diagnostics-log.js";
import { createCallNetworkRestoration } from "./call-network-restoration.js";
import { matchesCallResponse, createRequestEpoch } from "./call-request-guards.js";
import { explainMicrophoneError } from "./microphone-permissions.js";
import { classifyIceCandidate } from "./call-recovery-utils.js";
import { describeCallDiagnostics, selectedCallRoute, formatCallDuration, turnAvailable, isTemporaryTurnOnly, setTemporaryTurnOnly, callIcePolicy } from "./call-monitor.js";
import { api } from "./api.js";
import {
  applySelectedAudioProfileToTrack,
  getSelectedAudioProfile,
  requestCallMicrophone,
  tuneAudioSender,
  updateAudioProfileStatus
} from "./audio-profiles.js";
import { subscribeRealtime, reconnectRealtime, realtimeConnected } from "./shared-realtime.js";
import { tuneOpusSdp } from "./call-sdp-tuning.js";
import { createIceCandidateBatcher } from "./call-signal-batcher.js";
import { computeCallPollingIntervals } from "./call-polling-policy.js";
import {
  stepAdaptiveBitrateWithStats,
  markBitrateNetworkRecovered,
  stopAdaptiveBitrate
} from "./call-bitrate-controller.js";
import {
  createJitterBufferController,
  applyJitterBufferTarget,
  formatJitterBufferLabel
} from "./call-jitter-controller.js";
import {
  shouldInitiateOffer,
  reconcileMeshPeers,
  formatParticipantCount,
  buildGroupCallBannerText,
  formatParticipantStatus
} from "./group-call-mesh.js";
import {
  createGroupCallPickerState,
  formatCallPickerCount,
  formatCallPickerSubmitLabel
} from "./group-call-picker.js";
import { translateText } from "./i18n.js";
import { announce, elements, getCurrentSession } from "./ui.js";

let account = null;
let groupCallPickerChat = null;
let groupCallPickerState = null;
let groupCallPickerRequestId = 0;
let currentCall = null;
let localStream = null;
let peerConnection = null;
let peerConnectionPromise = null;
let peerCreationEpoch = 0;
let remoteCandidates = [];
let processedSignalSequences = new Set();
let signalPollCursor = 0;
let signalPollTimer = null;
let statePollTimer = null;
let activeSignalPollMs = null;
let activeStatePollMs = null;
let ringTimeout = null;
let unsubscribeCallRealtime = null;
let answeredLocally = false;
let offerStarted = false;
let restartInFlight = false;
let recoveryPending = false;
let muted = false;
let iceServersPromise = null;
let lastIceServers = null;
let iceServersFetchedAt = 0;
let icePrefetchTimer = null;
let disconnectRecoveryTimer = null;
let recoveryWatchdogTimer = null;
let recoveryAttempt = 0;
let qualityMonitorTimer = null;
let callTimerInterval = null;
let lastInboundAudioStats = null;
let lastSelectedCallRoute = null;
const jitterController = createJitterBufferController();
let audioConnectedOnce = false;
let networkRecoveryActive = false;
let lastConnectedAt = 0;
let watchdogExtended = false;
let callAbortController = null;
let callActivityActive = false;
let signalProcessingQueue = Promise.resolve();
let signalPollInFlight = false;
let signalPollRequestId = 0;
let statePollInFlight = false;
let statePollRequestId = 0;
const iceRequestEpoch = createRequestEpoch();
let localNegotiationId = null;
let remoteNegotiationId = null;
let remotePlaybackBlocked = false;
let relayCandidateSeen = false;
let headsetControls = null;
let pendingFastRecovery = null;
let profileSwitchEpoch = 0;
let profileSwitchQueue = Promise.resolve();
const groupPeers = new Map();
const activeGroupCallsByChat = new Map();
let selectedGroupChatId = null;
let localTrackRecovering = false;
let remoteAudioStopping = false;
let activeProfileSessionId = null;
let firstAudioProbeTimer = null;
let firstAudioProbeAttempts = 0;
let profileLoggedForSessionId = null;
let prewarmedIncoming = null;

function setCallActivityFlag(active) {
  const next = Boolean(active);
  if (callActivityActive === next) return;
  callActivityActive = next;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.bulbamCallActive = next ? "true" : "false";
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("bulbam:call-activity-changed", { detail: { active: next } }));
  }
}

function ensureCallAbortSignal() {
  if (typeof AbortController === "undefined") return undefined;
  if (!callAbortController || callAbortController.signal.aborted) {
    callAbortController = new AbortController();
  }
  return callAbortController.signal;
}

function abortCallRequests() {
  if (callAbortController) {
    try { callAbortController.abort(); } catch {}
    callAbortController = null;
  }
}

function isRelayCandidateSignal(item) {
  const text = item?.payload?.candidate;
  return typeof text === "string" && /\btyp relay\b/.test(text);
}

function hasFreshTurnCache() {
  return Boolean(
    lastIceServers &&
    (Date.now() - iceServersFetchedAt) < 120_000 &&
    turnAvailable(lastIceServers)
  );
}

function isGroupCall(call = currentCall) {
  return call?.kind === "group";
}

function isAnyRemoteAudioBlocked() {
  if (remotePlaybackBlocked) return true;
  for (const entry of groupPeers.values()) {
    if (entry.remotePlaybackBlocked) return true;
  }
  return false;
}

function ensureRemoteAudioPlaying() {
  if (!currentCall || remoteAudioStopping) return;
  const players = [];
  if (elements.callRemoteAudio?.srcObject) players.push(elements.callRemoteAudio);
  for (const entry of groupPeers.values()) {
    if (entry.audioEl?.srcObject) players.push(entry.audioEl);
  }
  for (const player of players) {
    if (player.paused && typeof player.play === "function") {
      void Promise.resolve().then(() => player.play()).catch(() => {});
    }
  }
}

const networkRestoration = createCallNetworkRestoration(({ reason, freshNetwork }) => {
  if (freshNetwork) recoveryGate.reset();
  if (!currentCall || currentCall.status !== "accepted" || recoveryPending) return;
  networkRecoveryActive = true;
  logCallEvent("восстановление", freshNetwork ? "сеть вернулась" : "маршрут изменился");
  if (isGroupCall(currentCall)) {
    void recoverAllGroupPeers(reason, freshNetwork);
    return;
  }
  initialConnectionWatchdog.disarm();
  clearTimeout(recoveryWatchdogTimer);
  recoveryWatchdogTimer = null;
  const desired = { hard: freshNetwork || recoveryAttempt > 0, reason };
  if (restartInFlight) {
    pendingFastRecovery = { ...desired, callId: currentCall.callId };
    return;
  }
  void recoverCallConnection(desired);
});

function onNetworkAvailable(reason) {
  if (navigator.onLine === false) return;
  networkRestoration.available(reason, {
    active: currentCall?.status === "accepted" && !recoveryPending,
    connected: isPeerConnected() && !networkRecoveryActive
  });
}

const DISCONNECT_RECOVERY_GRACE_MS = 3_500;
// Mobile ICE/TURN negotiation may take longer than 7 seconds after a radio handover.
const RECOVERY_WATCHDOG_MS = 12_000;
const QUALITY_SAMPLE_MS = 2_000;
const FALLBACK_ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
const ICE_CANDIDATE_POOL_SIZE = 4;
const ICE_CACHE_TTL_MS = 180_000;
const iceBatcher = createIceCandidateBatcher({
  flush: flushIceCandidateBatch,
  windowMs: 40,
  maxBatch: 8,
  immediateFirst: true,
  isUrgent: isRelayCandidateSignal
});
const recoveryGate = createRecoveryGate();
const initialConnectionWatchdog = createCallConnectionWatchdog((callId) => {
  if (currentCall?.callId !== callId || currentCall.status !== "accepted" || isPeerConnected()) return;
  // On slow mobile links, TURN relay gathering or an in-flight offer may still be
  // progressing at 12s. Give one 6-second grace extension before tearing it down.
  if (!watchdogExtended && (peerConnection?.iceGatheringState === "gathering" || restartInFlight)) {
    watchdogExtended = true;
    logCallEvent("ожидание подключения", "сбор ICE ещё идёт");
    setTimeout(() => {
      if (currentCall?.callId !== callId || currentCall.status !== "accepted" || isPeerConnected()) return;
      logCallEvent("таймер подключения истёк", "18 s");
      setCallStatus("Соединение зависло. Автоматически восстанавливаю аудио…");
      void recoverCallConnection({ hard: false, reason: "initial-connection-timeout" });
    }, 6_000);
    return;
  }
  logCallEvent("таймер подключения истёк", "12 s");
  if (isTemporaryTurnOnly() && !relayCandidateSeen) {
    logCallEvent("TURN не дал relay", "нет кандидата за 12 секунд");
    setCallStatus("TURN не отвечает в этой сети. Переподключаюсь через запасной TLS-маршрут…");
  } else {
    setCallStatus("Соединение зависло. Автоматически восстанавливаю аудио…");
  }
  void recoverCallConnection({ hard: false, reason: "initial-connection-timeout" });
});

let callAudioNeedsRefresh = false;
function markCallAudioInterrupted() { callAudioNeedsRefresh = true; }
function restoreCallAudioOnReturn() {
  if (!callAudioNeedsRefresh || document.visibilityState !== "visible") return;
  callAudioNeedsRefresh = false;
  // Safari may claim an AudioContext is still running after iOS interrupted output.
  // Recreate local feedback only, never disturb live WebRTC media.
  resetCallCueAudio();
  const wasRinging = currentCall?.status === "ringing" && currentCall.direction === "outgoing";
  resetRingbackAudio();
  if (wasRinging) startRingback();
}

export function setupCalls() {
  window.addEventListener("pagehide", markCallAudioInterrupted);
  window.addEventListener("pageshow", restoreCallAudioOnReturn);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") markCallAudioInterrupted();
    else restoreCallAudioOnReturn();
  });
  headsetControls = createCallHeadsetControls(navigator, {
    onMute: (next) => setMuted(next),
    onHangup: () => { if (currentCall) void endCall(); },
    onMediaKey: () => ensureRemoteAudioPlaying()
  });
  // Pressing headset Play/Pause on iOS/Safari can pause the active <audio> tag.
  // Keep remote voice playing whenever the call is still active.
  elements.callRemoteAudio?.addEventListener?.("pause", () => {
    if (!currentCall || remoteAudioStopping || !elements.callRemoteAudio?.srcObject) return;
    void Promise.resolve().then(() => elements.callRemoteAudio.play()).catch(() => {});
  });
  elements.callStartButton.addEventListener("click", () => {
    prepareRingback();
    prepareCallCues();
    void startCall();
  });
  elements.groupCallJoinButton?.addEventListener("click", () => {
    prepareCallCues();
    void joinActiveGroupCallFromBanner();
  });
  elements.callAnswerButton.addEventListener("click", () => { prepareCallCues(); void answerCall(); });
  elements.callDeclineButton.addEventListener("click", () => { prepareCallCues(); void declineCall(); });
  elements.callResumeButton.addEventListener("click", () => void resumeRecoveredCall());
  elements.callHandoffButton.addEventListener("click", () => void handoffCall());
  document.querySelector("#call-discover")?.addEventListener("click",()=>void discoverActiveCall());
  elements.callEndButton.addEventListener("click", () => { prepareCallCues(); void endCall(); });
  elements.callEndAllButton?.addEventListener("click", () => { prepareCallCues(); void endCall({ endForAll: true }); });
  const routeChoice=document.querySelector("#turn-route-preference");
  if(routeChoice){
    routeChoice.value=isTemporaryTurnOnly()?"relay":"auto";
    routeChoice.addEventListener("change",async()=>{
      const turnOnly=routeChoice.value==="relay";
      if(turnOnly){
        routeChoice.disabled=true;
        try{
          const servers=await getIceServers({refresh:true});
          if(!turnAvailable(servers)){
            routeChoice.value="auto";
            setTemporaryTurnOnly(false);
            const status=document.querySelector("#turn-route-availability");
            if(status)status.textContent="TURN не выдан сервером. Оставлен автоматический режим.";
            announce("TURN не выдан сервером. Оставлен автоматический режим.");
            return;
          }
        }finally{routeChoice.disabled=false;}
      }
      if(!setTemporaryTurnOnly(turnOnly)){
        routeChoice.value=isTemporaryTurnOnly()?"relay":"auto";
        announce("Не удалось сохранить временный режим TURN.");
        return;
      }
      const status=document.querySelector("#turn-route-availability");
      if(status)status.textContent=turnOnly
        ?"TURN включён для следующих звонков.":"Автоматический выбор STUN/TURN включён.";
      announce(turnOnly
        ?"TURN включён для следующих звонков.":"Автоматический выбор STUN/TURN включён.");
    });
  }
  elements.callMuteButton.addEventListener("click", toggleMute);
  elements.callMinimizeButton.addEventListener("click", minimizeCall);
  elements.callExpandButton.addEventListener("click", expandCall);
  elements.callDismissButton.addEventListener("click", dismissFinishedCall);
  elements.groupCallPickerSelectAllButton?.addEventListener("click", () => {
    if (!groupCallPickerState) return;
    groupCallPickerState.toggleAll();
    renderGroupCallPicker();
  });
  elements.groupCallPickerCancelButton?.addEventListener("click", () => {
    closeGroupCallPicker({ restoreFocus: true });
  });
  elements.groupCallPickerDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeGroupCallPicker({ restoreFocus: true });
  });
  elements.groupCallPickerSubmitButton?.addEventListener("click", () => {
    if (!groupCallPickerChat || !groupCallPickerState) return;
    const snap = groupCallPickerState.snapshot();
    if (!snap.canCall) return;
    const targetChat = groupCallPickerChat;
    const invitedUserIds = [...snap.selectedIds];
    closeGroupCallPicker({ restoreFocus: false });
    prepareRingback();
    prepareCallCues();
    void executeStartCall(targetChat, { invitedUserIds });
  });

  const observer = new MutationObserver(syncCallButton);
  observer.observe(elements.conversationPeer, { childList: true, characterData: true, subtree: true });
  observer.observe(elements.messageForm, { attributes: true, attributeFilter: ["hidden"] });

  window.addEventListener("bulbam:account-changed", (event) => {
    void switchAccount(event.detail?.account ?? null);
  });
  window.addEventListener("bulbam:chat-changed", (event) => {
    const chat = event.detail?.chat ?? null;
    selectedGroupChatId = chat?.kind === "group" ? chat.conversationId : null;
    renderGroupCallBanner();
    syncCallButton();
    if (selectedGroupChatId && account) {
      void refreshActiveGroupCallForChat(selectedGroupChatId);
    }
  });
  window.addEventListener("bulbam:audio-profile-changed", () => {
    void applyAudioProfileDuringCall();
  });
  window.addEventListener("offline", () => {
    if (!currentCall || currentCall.status !== "accepted" || recoveryPending) return;
    networkRestoration.offline();
    networkRecoveryActive = true;
    if (isGroupCall(currentCall)) {
      for (const entry of groupPeers.values()) raiseJitterBufferForNetworkStress(entry.pc, "severe");
    } else {
      raiseJitterBufferForNetworkStress(peerConnection, "severe");
    }
    setCallStatus("Сеть недоступна. Сохраняю звонок и жду восстановления подключения…");
  });
  window.addEventListener("online", () => onNetworkAvailable("online"));
  window.addEventListener("pageshow", () => onNetworkAvailable("page-returned"));
  window.addEventListener("focus", () => onNetworkAvailable("page-returned"));
  // NetworkInformation is optional in Safari; the ICE watchdog covers devices
  // where the browser never emits a network-change notification.
  try {
    navigator.connection?.addEventListener?.("change", () => onNetworkAvailable("connection-change"));
  } catch {}

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    clearCallNotifications(currentCall?.callId || "");
    if (account && !realtimeConnected()) reconnectRealtime({ resetBackoff: true });
    // A backgrounded iPhone may miss the remote hang-up WebSocket event.
    // Reconcile server state as soon as the app is visible again.
    if (currentCall) void pollCallState();
    onNetworkAvailable("page-returned");
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
  if (currentCall) { logCallEvent("смена аккаунта"); cleanupMedia(); }
  account = nextAccount;
  currentCall = null;
  activeGroupCallsByChat.clear();
  selectedGroupChatId = null;
  resetCallRuntime();
  closeCallRealtime();
  renderIdle();
  renderGroupCallBanner();
  syncCallButton();
  if (!account) return;
  connectCallRealtime();
  scheduleBackgroundIcePrefetch();
  await restoreCallFromUrl();
}

function scheduleBackgroundIcePrefetch() {
  clearTimeout(icePrefetchTimer);
  icePrefetchTimer = null;
  if (!account || lastIceServers) return;
  icePrefetchTimer = setTimeout(() => {
    icePrefetchTimer = null;
    if (!account || currentCall || lastIceServers) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    void prefetchIceServers();
  }, 1_500);
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
      void prefetchIceServers();
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
    // Realtime may already have delivered the event or the short-lived call may have ended.
  }
}

function closeGroupCallPicker({ restoreFocus = false } = {}) {
  groupCallPickerRequestId += 1;
  groupCallPickerChat = null;
  groupCallPickerState = null;
  if (elements.groupCallPickerDialog?.open) {
    elements.groupCallPickerDialog.close();
  }
  if (restoreFocus && !elements.callStartButton.hidden && !elements.callStartButton.disabled) {
    elements.callStartButton.focus();
  }
}

function renderGroupCallPicker() {
  if (!groupCallPickerState) return;
  const snap = groupCallPickerState.snapshot();
  if (elements.groupCallPickerCount) {
    elements.groupCallPickerCount.textContent = translateText(formatCallPickerCount(snap.selectedCount));
  }
  if (elements.groupCallPickerSelectAllButton) {
    elements.groupCallPickerSelectAllButton.hidden = snap.candidates.length < 2;
    elements.groupCallPickerSelectAllButton.textContent = translateText(
      snap.allSelected ? "Снять выбор" : "Выбрать всех"
    );
  }
  if (elements.groupCallPickerSubmitButton) {
    elements.groupCallPickerSubmitButton.hidden = !snap.canCall;
    elements.groupCallPickerSubmitButton.textContent = translateText(
      formatCallPickerSubmitLabel(snap.selectedCount)
    );
  }
  if (!elements.groupCallPickerList) return;
  elements.groupCallPickerList.replaceChildren();
  if (snap.candidates.length === 0) {
    if (elements.groupCallPickerStatus) {
      elements.groupCallPickerStatus.textContent = translateText("В группе пока нет других участников для звонка.");
    }
    return;
  }
  if (elements.groupCallPickerStatus) {
    elements.groupCallPickerStatus.textContent = "";
  }
  for (const member of snap.candidates) {
    const selected = groupCallPickerState.isSelected(member.userId);
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-user-choice";
    button.setAttribute("aria-pressed", selected ? "true" : "false");

    const nameSpan = document.createElement("span");
    nameSpan.dataset.userContent = "true";
    nameSpan.textContent = member.username
      ? `${member.displayName} (@${member.username})`
      : member.displayName;

    const badge = document.createElement("span");
    badge.className = "group-call-picker-badge";
    badge.textContent = translateText(selected ? "Выбран" : "Не выбран");

    button.append(nameSpan, badge);
    button.addEventListener("click", () => {
      if (!groupCallPickerState) return;
      groupCallPickerState.toggle(member.userId);
      renderGroupCallPicker();
    });
    li.append(button);
    elements.groupCallPickerList.append(li);
  }
}

async function openGroupCallPicker(chat) {
  if (!elements.groupCallPickerDialog) {
    await executeStartCall(chat);
    return;
  }
  const requestId = ++groupCallPickerRequestId;
  groupCallPickerChat = chat;
  groupCallPickerState = createGroupCallPickerState([], account?.userId ?? null);

  if (elements.groupCallPickerTitle) {
    elements.groupCallPickerTitle.textContent = translateText("Кому позвонить?");
  }
  if (elements.groupCallPickerCount) {
    elements.groupCallPickerCount.textContent = translateText(formatCallPickerCount(0));
  }
  if (elements.groupCallPickerSelectAllButton) {
    elements.groupCallPickerSelectAllButton.hidden = true;
  }
  if (elements.groupCallPickerSubmitButton) {
    elements.groupCallPickerSubmitButton.hidden = true;
    elements.groupCallPickerSubmitButton.textContent = translateText("Позвонить");
  }
  if (elements.groupCallPickerList) {
    elements.groupCallPickerList.replaceChildren();
  }
  if (elements.groupCallPickerStatus) {
    elements.groupCallPickerStatus.textContent = translateText("Загружаем участников группы…");
  }

  if (!elements.groupCallPickerDialog.open) {
    elements.groupCallPickerDialog.showModal();
  }
  elements.groupCallPickerTitle?.focus();

  try {
    const result = await api(`/api/v1/chats/${encodeURIComponent(chat.conversationId)}/members`);
    if (requestId !== groupCallPickerRequestId || !groupCallPickerState) return;
    groupCallPickerState.setMembers(result.members ?? []);
    renderGroupCallPicker();
    if (groupCallPickerState.snapshot().candidates.length === 0) {
      announce("В группе пока нет других участников для звонка.");
    }
  } catch (error) {
    if (requestId !== groupCallPickerRequestId) return;
    if (elements.groupCallPickerStatus) {
      elements.groupCallPickerStatus.textContent = translateText("Не удалось загрузить список участников.");
    }
    announce(`Не удалось загрузить список участников: ${error.message}`);
  }
}

async function startCall() {
  if (!account || currentCall) return;
  const chat = await selectedChatFromUi();
  if (!chat) {
    announce("Сначала откройте чат.");
    return;
  }
  if (chat.kind === "group") {
    const existingGroupCall = activeGroupCallsByChat.get(chat.conversationId);
    if (existingGroupCall?.callId) {
      selectedGroupChatId = chat.conversationId;
      await joinActiveGroupCallFromBanner();
      return;
    }
    await openGroupCallPicker(chat);
    return;
  }
  await executeStartCall(chat);
}

async function executeStartCall(chat, { invitedUserIds = null } = {}) {
  if (!account || currentCall || !chat) return;
  elements.callStartButton.disabled = true;
  activeProfileSessionId = callProfiler.start("outgoing", { kind: chat.kind === "group" ? "group" : "direct" });
  const profileSessionId = activeProfileSessionId;
  try {
    // Fetch short-lived TURN credentials while the user grants microphone
    // access and the room is being created. These independent network waits
    // must not add up sequentially on slow cellular connections.
    void prefetchIceServers();
    logCallEvent("запрос микрофона");
    callProfiler.mark("mic_start", profileSessionId);
    localStream = await requestMicrophone();
    callProfiler.mark("mic_ready", profileSessionId);
    logCallEvent("микрофон доступен");
    const init = Array.isArray(invitedUserIds) && invitedUserIds.length > 0
      ? { method: "POST", body: JSON.stringify({ invitedUserIds }) }
      : { method: "POST" };
    callProfiler.mark("call_create_start", profileSessionId);
    const result = await api(`/api/v1/chats/${encodeURIComponent(chat.conversationId)}/calls`, init);
    callProfiler.mark("call_create_done", profileSessionId);
    currentCall = result.call;
    offerStarted = false;
    recoveryPending = false;
    if (isGroupCall(currentCall)) {
      answeredLocally = true;
      startCallTrace("outgoing");
      playCallCue("connected");
      rememberActiveGroupCall(currentCall);
      showConnectedControls(groupCallStatusText());
      renderCallParticipants();
      await syncGroupPeers();
      startCallPolling();
      renderGroupCallBanner();
      const groupName = currentCall.groupTitle || currentCall.peer?.displayName || "Группа";
      const total = currentCall.participants?.length ?? 1;
      announce(total > 1
        ? `Вы присоединились к групповому звонку «${groupName}». Участников: ${total}.`
        : `Групповой звонок «${groupName}» запущен. Режим звука: ${getSelectedAudioProfile().label}.`);
      return;
    }
    answeredLocally = false;
    startCallTrace("outgoing");
    showOutgoing(currentCall);
    startRingback();
    void prewarmOutgoingPeerConnection();
    startCallPolling();
    ringTimeout = setTimeout(() => void timeoutRinging(), 60_000);
    announce(`Звоним ${currentCall.peer.displayName}. Режим звука: ${getSelectedAudioProfile().label}.`);
  } catch (error) {
    callProfiler.setMeta({ status: "failed" }, profileSessionId);
    stopLocalStream();
    announce(`Не удалось начать звонок: ${friendlyMediaError(error)}`);
  } finally {
    elements.callStartButton.disabled = false;
    syncCallButton();
  }
}

async function joinActiveGroupCallFromBanner() {
  if (!account || currentCall || !selectedGroupChatId) return;
  const active = activeGroupCallsByChat.get(selectedGroupChatId);
  if (!active?.callId) return;
  const joinButton = elements.groupCallJoinButton;
  if (joinButton) joinButton.disabled = true;
  try {
    void prefetchIceServers();
    logCallEvent("запрос микрофона");
    localStream = await requestMicrophone();
    logCallEvent("микрофон доступен");
    const result = await api(
      `/api/v1/chats/${encodeURIComponent(selectedGroupChatId)}/calls/${encodeURIComponent(active.callId)}/join`,
      { method: "POST" }
    );
    currentCall = result.call;
    answeredLocally = true;
    offerStarted = false;
    recoveryPending = false;
    startCallTrace("incoming");
    playCallCue("answered");
    rememberActiveGroupCall(currentCall);
    showConnectedControls(groupCallStatusText());
    renderCallParticipants();
    await syncGroupPeers();
    startCallPolling();
    renderGroupCallBanner();
    const groupName = currentCall.groupTitle || currentCall.peer?.displayName || "Группа";
    announce(`Вы присоединились к групповому звонку «${groupName}». Режим звука: ${getSelectedAudioProfile().label}.`);
  } catch (error) {
    stopLocalStream();
    announce(`Не удалось присоединиться к групповому звонку: ${friendlyMediaError(error)}`);
  } finally {
    if (joinButton) joinButton.disabled = false;
    syncCallButton();
  }
}

async function answerCall() {
  if (!account || !currentCall) return;
  if (isGroupCall(currentCall)) {
    if (currentCall.joined) return;
    const answeringCallId = currentCall.callId;
    elements.callAnswerButton.disabled = true;
    answeredLocally = true;
    try {
      void prefetchIceServers();
      logCallEvent("запрос микрофона");
      const microphone = await requestMicrophone();
      if (currentCall?.callId !== answeringCallId) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }
      localStream = microphone;
      logCallEvent("микрофон доступен");
      const joined = await api(callPath("/join"), { method: "POST" });
      if (currentCall?.callId !== answeringCallId) return;
      logCallEvent("звонок принят");
      clearCallNotifications(answeringCallId);
      playCallCue("answered");
      currentCall = joined.call;
      recoveryPending = false;
      rememberActiveGroupCall(currentCall);
      showConnectedControls(groupCallStatusText());
      renderCallParticipants();
      await syncGroupPeers();
      startCallPolling();
      renderGroupCallBanner();
      const groupName = currentCall.groupTitle || currentCall.peer?.displayName || "Группа";
      announce(`Вы присоединились к групповому звонку «${groupName}». Режим звука: ${getSelectedAudioProfile().label}.`);
    } catch (error) {
      if (currentCall?.callId !== answeringCallId) return;
      answeredLocally = false;
      cleanupGroupPeers();
      stopLocalStream();
      elements.callAnswerButton.hidden = false;
      elements.callDeclineButton.hidden = false;
      setCallStatus(`Не удалось присоединиться: ${friendlyMediaError(error)}`);
      announce(`Не удалось присоединиться: ${friendlyMediaError(error)}`);
    } finally {
      elements.callAnswerButton.disabled = false;
    }
    return;
  }
  if (currentCall.status !== "ringing" || currentCall.direction !== "incoming") return;
  const answeringCallId = currentCall.callId;
  const answerEndpoint = callPath("/answer");
  const endEndpoint = callPath("/end");
  elements.callAnswerButton.disabled = true;
  answeredLocally = true;
  setCallActivityFlag(true);
  activeProfileSessionId = callProfiler.start("incoming", { kind: "direct" });
  const profileSessionId = activeProfileSessionId;
  let acquiredMic = null;
  let serverAccepted = false;
  let answerFlowFailed = false;
  try {
    // Run microphone acquisition, TURN/ICE credential resolution, and POST /answer
    // concurrently, and do NOT block WebRTC SDP/ICE/DTLS on slow iOS CoreAudio
    // microphone switching (which takes ~1000 ms). As soon as POST /answer returns
    // with the caller's pre-offer + ICE candidates, start SDP answer + ICE + DTLS
    // immediately and attach the real microphone track via replaceTrack once ready.
    logCallEvent("запрос микрофона");
    callProfiler.mark("mic_start", profileSessionId);
    const micPromise = requestMicrophone().then((stream) => {
      acquiredMic = stream;
      callProfiler.mark("mic_ready", profileSessionId);
      logCallEvent("микрофон доступен");
      return stream;
    });
    const icePromise = getIceServers().catch(() => lastIceServers ?? FALLBACK_ICE_SERVERS);
    const sendAnswerRequest = async () => {
      callProfiler.mark("answer_http_start", profileSessionId);
      const response = await api(answerEndpoint, { method: "POST", signal: ensureCallAbortSignal() });
      callProfiler.mark("answer_http_done", profileSessionId);
      serverAccepted = true;
      return response;
    };
    const [iceResult, serverAnswer] = await Promise.allSettled([
      icePromise,
      sendAnswerRequest()
    ]);

    if (currentCall?.callId !== answeringCallId) {
      answerFlowFailed = true;
      void micPromise.then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      }).catch(() => {});
      return;
    }
    if (serverAnswer.status === "rejected") {
      answerFlowFailed = true;
      void micPromise.then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      }).catch(() => {});
      throw serverAnswer.reason;
    }

    if (acquiredMic) {
      localStream = acquiredMic;
    }
    const resolvedIceServers = iceResult.status === "fulfilled" ? iceResult.value : null;
    logCallEvent("звонок принят");
    clearCallNotifications(answeringCallId);
    playCallCue("answered");
    currentCall = serverAnswer.value.call;
    recoveryPending = false;

    // Attach deferred microphone track as soon as getUserMedia resolves (or cleanly
    // abort the call if the user denies microphone permission). Serialize through
    // signalProcessingQueue so track attachment never races setRemoteDescription/createAnswer.
    void micPromise.then((stream) => {
      if (answerFlowFailed || currentCall?.callId !== answeringCallId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (localStream !== stream) {
        localStream = stream;
      }
      const attachJob = signalProcessingQueue.then(async () => {
        if (answerFlowFailed || currentCall?.callId !== answeringCallId || !peerConnection) return;
        await attachLocalStreamToPeerConnection(peerConnection, stream, profileSessionId);
      });
      signalProcessingQueue = attachJob.then(() => {}, () => {});
    }).catch((micError) => {
      if (answerFlowFailed || currentCall?.callId !== answeringCallId) return;
      answerFlowFailed = true;
      callProfiler.setMeta({ status: "failed" }, profileSessionId);
      if (serverAccepted) void deliverCallTermination(endEndpoint);
      answeredLocally = false;
      cleanupPeerConnection();
      stopLocalStream();
      elements.callAnswerButton.hidden = false;
      elements.callDeclineButton.hidden = false;
      setCallStatus(`Не удалось ответить: ${friendlyMediaError(micError)}`);
      announce(`Не удалось ответить: ${friendlyMediaError(micError)}`);
    });

    let pc = null;
    try {
      pc = await ensurePeerConnection({
        iceServers: resolvedIceServers,
        allowDeferredMic: !localStream
      });
    } catch {
      if (currentCall?.callId !== answeringCallId) return;
      showConnectedControls("Ответ отправлен. Подключаю резервный аудиомаршрут…");
      startCallPolling();
      void recoverCallConnection({ hard: true, reason: "initial-peer-creation" });
      return;
    }
    if (currentCall?.callId !== answeringCallId || pc !== peerConnection) return;

    // If the mic finished resolving while ensurePeerConnection was in flight, attach it now.
    if (localStream) {
      await attachLocalStreamToPeerConnection(pc, localStream, profileSessionId);
    }

    showConnectedControls("Соединяем звонок…");
    const piggybackedSignals = Array.isArray(serverAnswer.value.signals) ? serverAnswer.value.signals : [];
    let hasPreOffer = false;
    for (const signal of piggybackedSignals) {
      if (signal?.kind === "offer") hasPreOffer = true;
    }
    if (piggybackedSignals.length) {
      for (const signal of piggybackedSignals) {
        if (currentCall?.callId !== answeringCallId || recoveryPending || answerFlowFailed) break;
        const processed = await enqueueSignal(signal);
        if (processed) {
          signalPollCursor = Math.max(signalPollCursor, Number(signal.sequence) || 0);
        }
      }
    }
    // If the caller's pre-offer already arrived inside POST /answer, skip the
    // redundant immediate GET /signals burst and keep normal safety polling.
    syncCallPollingCadence({ immediateSignals: !hasPreOffer, immediateState: false });
    announce(`Вы ответили ${currentCall.peer.displayName}. Режим звука: ${getSelectedAudioProfile().label}.`);
  } catch (error) {
    answerFlowFailed = true;
    if (currentCall?.callId !== answeringCallId) return;
    callProfiler.setMeta({ status: "failed" }, profileSessionId);
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
  if (!account || !currentCall) return;
  // iOS/Safari can establish WebRTC while rejecting the autoplay promise.
  // This action must run play() directly in a real click gesture and MUST NOT
  // close or renegotiate an already-connected peer connection.
  if (isGroupCall(currentCall) && isAnyRemoteAudioBlocked()) {
    let anyStillBlocked = false;
    for (const entry of groupPeers.values()) {
      if (entry.remotePlaybackBlocked && entry.audioEl?.srcObject) {
        try {
          await entry.audioEl.play();
          entry.remotePlaybackBlocked = false;
        } catch {
          anyStillBlocked = true;
        }
      }
    }
    if (!anyStillBlocked) {
      elements.callResumeButton.hidden = true;
      announce("Звук звонка включён.");
      setCallStatus(groupCallStatusText());
    } else {
      setCallStatus("Браузер не разрешил воспроизвести звук. Попробуйте нажать ещё раз.");
    }
    return;
  }
  if (remotePlaybackBlocked && elements.callRemoteAudio.srcObject) {
    const player = elements.callRemoteAudio;
    try {
      await player.play();
      remotePlaybackBlocked = false;
      elements.callResumeButton.hidden = true;
      announce("Звук звонка включён.");
      setCallStatus("Аудио воспроизводится. Разговор продолжается.");
    } catch (error) {
      setCallStatus("Браузер не разрешил воспроизвести звук: " + friendlyMediaError(error));
    }
    return;
  }
  if (!recoveryPending) return;
  elements.callResumeButton.disabled = true;
  try {
    if (!localStream) localStream = await requestMicrophone();
    await prepareRecoveryCursor();
    if (isGroupCall(currentCall)) {
      cleanupGroupPeers();
      recoveryPending = false;
      showConnectedControls("Восстанавливаю групповой звонок…");
      renderCallParticipants();
      await syncGroupPeers({ forceRenegotiate: true });
      startCallPolling();
      announce(`Звук группового звонка «${currentCall.groupTitle || currentCall.peer?.displayName || "Группа"}» восстанавливается.`);
      return;
    }
    cleanupPeerConnection();
    remoteCandidates = [];
    offerStarted = false;
    recoveryPending = false;

    if (currentCall.status === "accepted") {
      showConnectedControls("Восстанавливаю аудиосоединение…");
      startCallPolling();
      clearAutomaticRecoveryTimers();
      recoveryAttempt = 2;
      networkRecoveryActive = true;
      if (currentCall.direction === "outgoing") {
        const restored = await restartOffer({ rebuild: true, refreshIce: true });
        if (!restored) throw new Error("не удалось перестроить аудиосоединение");
      } else {
        await sendSignal("resume", { reason: "client-reconnect", mode: "rebuild" });
      }
      armRecoveryWatchdog();
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

async function discoverActiveCall() {
  try{
    const result=await api("/api/v1/calls/active");
    if(!result.call || result.call.status!=="accepted") {
      announce("На ваших устройствах нет активного разговора.");
      return;
    }
    if(currentCall?.callId===result.call.callId && !recoveryPending){
      announce("Звонок уже работает на этом устройстве.");
      return;
    }
    if(currentCall && currentCall.callId!==result.call.callId){
      announce("Сначала завершите или закройте предыдущий звонок.");
      return;
    }
    currentCall=result.call;
    recoveryPending=true;
    showRecoveredCall("Активный звонок найден. Можно перенести его на это устройство.");
    announce("Активный звонок найден. Выберите перенос на это устройство.");
  }catch(error){announce("Не удалось проверить активный звонок: "+error.message);}
}

async function handoffCall() {
  if(!currentCall || currentCall.status!=="accepted" || !recoveryPending)return;
  const button=elements.callHandoffButton;
  button.disabled=true;
  try {
    if(!localStream)localStream=await requestMicrophone();
    // Source keeps the call alive until this authenticated device claims it.
    const result=await api(callPath("/handoff"),{method:"POST"});
    currentCall=result.call;
    elements.callHandoffButton.hidden=true;
    announce("Перенос Бульбам Пераход подтверждён. Подключаю звук.");
    await resumeRecoveredCall();
  }catch(error) {
    setCallStatus("Перенос не выполнен: "+error.message);
    announce("Не удалось перенести звонок: "+error.message);
  }finally{button.disabled=false;}
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

async function endCall({ endForAll = false } = {}) {
  if (!currentCall) return;
  const group = isGroupCall(currentCall);
  // Release the mic, speakers, and RTCPeerConnection immediately, regardless
  // of mobile network latency. The room update then ends it on every device.
  const path = callPath(group ? "/leave" : "/end");
  const body = group && endForAll ? { endForAll: true } : null;
  elements.callEndButton.disabled = true;
  if (elements.callEndAllButton) elements.callEndAllButton.disabled = true;
  const endMessage = group
    ? (endForAll ? "Групповой звонок завершён для всех." : "Вы покинули групповой звонок.")
    : "Звонок завершён.";
  finishCall(endMessage);
  announce(endMessage);
  elements.callEndButton.disabled = false;
  if (elements.callEndAllButton) elements.callEndAllButton.disabled = false;
  await deliverCallTermination(path, body);
  if (selectedGroupChatId) void refreshActiveGroupCallForChat(selectedGroupChatId);
}

async function deliverCallTermination(path, body = null) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api(path, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return;
    } catch (error) {
      logCallEvent("завершение не доставлено", "повтор отправки");
      // Retry only on an intermittent network failure, not a permission denial.
      const status = Number(error?.status);
      if (status && status < 500 && status !== 408 && status !== 429) return;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
}

async function timeoutRinging() {
  if (!currentCall || currentCall.status !== "ringing" || currentCall.direction !== "outgoing") return;
  const path = callPath("/end");
  finishCall("Нет ответа.");
  void deliverCallTermination(path);
  announce("На звонок не ответили.");
}

async function selectedChatFromUi() {
  if (elements.messageForm.hidden) return null;

  const conversationId = elements.messageForm.dataset?.conversationId;
  const kind = elements.messageForm.dataset?.chatKind ?? "direct";
  if (conversationId) return { conversationId, kind };

  // Compatibility fallback for tests and old cached markup. Presence text may follow
  // the username, so never treat the whole visible line as the username.
  const peerText = elements.conversationPeer.textContent.trim();
  const username = peerText.match(/^@([^·\s]+)/u)?.[1] ?? "";
  if (!username) return null;

  const result = await api("/api/v1/chats");
  return (result.chats ?? []).find((chat) => chat.peer?.username === username) ?? null;
}

function connectCallRealtime() {
  if (!account || unsubscribeCallRealtime) return;
  unsubscribeCallRealtime = subscribeRealtime(account.userId, {
    open: () => {
      syncCallPollingCadence();
    },
    message: (payload) => {
      void handleCallEvent(payload).catch((error) => {
        logDiagnostic("Ошибки", "обработка события звонка", diagnosticErrorName(error));
      });
    },
    close: () => {
      syncCallPollingCadence();
    }
  });
}

function closeCallRealtime() {
  if (unsubscribeCallRealtime) {
    unsubscribeCallRealtime();
    unsubscribeCallRealtime = null;
  }
}

async function handleCallEvent(event) {
  if (!account || !event || typeof event !== "object") return;

  if (event.type === "call.group.updated" && event.conversationId) {
    if (event.active) {
      activeGroupCallsByChat.set(event.conversationId, {
        callId: event.callId,
        conversationId: event.conversationId,
        groupTitle: event.groupTitle,
        avatarIcon: event.avatarIcon,
        participantCount: event.participantCount,
        participants: event.participants ?? []
      });
    } else {
      activeGroupCallsByChat.delete(event.conversationId);
    }
    renderGroupCallBanner();
    syncCallButton();
    if (!event.active && currentCall?.callId === event.callId) {
      finishCall("Групповой звонок завершён.");
      announce("Групповой звонок завершён.");
    }
    return;
  }

  if (event.type === "call.active" && event.call) {
    if (currentCall) return;
    currentCall = event.call;
    startCallTrace(currentCall.direction);
    answeredLocally = false;
    offerStarted = false;
    if (isGroupCall(currentCall)) {
      rememberActiveGroupCall(currentCall);
      renderGroupCallBanner();
      if (currentCall.status === "accepted") {
        recoveryPending = true;
        showRecoveredCall("Активный групповой звонок найден. Нажмите «Восстановить звук».");
        renderCallParticipants();
        startStatePolling();
        announce(`Активный групповой звонок «${currentCall.groupTitle || currentCall.peer.displayName}» найден.`);
      } else {
        currentCall = null;
        renderIdle();
      }
      return;
    }
    if (currentCall.status === "ringing" && currentCall.direction === "incoming") {
      recoveryPending = false;
      showIncoming(currentCall);
      void prefetchIceServers().then(() => prewarmIncomingPeerConnection(currentCall));
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
    if (isGroupCall(event.call)) {
      rememberActiveGroupCall(event.call);
      renderGroupCallBanner();
    }
    if (!currentCall) {
      currentCall = event.call;
      startCallTrace(currentCall.direction);
      answeredLocally = false;
      offerStarted = false;
      recoveryPending = false;
      showIncoming(currentCall);
      void prefetchIceServers().then(() => {
        if (!isGroupCall(currentCall)) prewarmIncomingPeerConnection(currentCall);
      });
      startStatePolling();
      if (isGroupCall(currentCall)) {
        announce(`Входящий групповой звонок в группе ${currentCall.groupTitle || currentCall.peer.displayName} от ${currentCall.caller?.displayName ?? "участника"}.`);
      } else {
        announce(`Входящий звонок от ${currentCall.peer.displayName}.`);
      }
    }
    return;
  }

  if (!currentCall || event.callId !== currentCall.callId) return;

  if (event.type === "call.participant.joined" && isGroupCall(currentCall)) {
    const joined = event.participant;
    if (Array.isArray(event.participants)) {
      currentCall = { ...currentCall, ...(event.call ?? {}), participants: event.participants, participantCount: event.participants.length };
    }
    rememberActiveGroupCall(currentCall);
    renderGroupCallBanner();
    renderCallParticipants();
    if (currentCall.joined && !recoveryPending) {
      setCallStatus(groupCallStatusText());
      await syncGroupPeers();
      if (joined && joined.userId !== account.userId) {
        playCallCue("answered");
        announce(`${joined.displayName} присоединился к звонку.`);
      }
    }
    return;
  }

  if (event.type === "call.participant.left" && isGroupCall(currentCall)) {
    const previous = (currentCall.participants ?? []).find((entry) => entry.userId === event.userId);
    if (Array.isArray(event.participants)) {
      currentCall = { ...currentCall, ...(event.call ?? {}), participants: event.participants, participantCount: event.participants.length };
    }
    rememberActiveGroupCall(currentCall);
    renderGroupCallBanner();
    if (event.userId) removeGroupPeer(event.userId);
    renderCallParticipants();
    if (currentCall.joined && !recoveryPending) {
      setCallStatus(groupCallStatusText());
      if (previous && previous.userId !== account.userId) {
        announce(`${previous.displayName} покинул звонок.`);
      }
    }
    return;
  }

  if (event.type === "call.participant.updated") {
    if (isGroupCall(currentCall) && Array.isArray(event.participants)) {
      currentCall = { ...currentCall, participants: event.participants, participantCount: event.participants.length };
      renderCallParticipants();
    }
    return;
  }

  if (event.type === "call.handoff") {
    if (event.actorUserId === account.userId && event.newSessionId !== getCurrentSession()?.sessionId) {
      finishCall("Звонок перенесён на другое ваше устройство.");
      announce("Звонок продолжен на другом устройстве.");
    } else if (event.actorUserId !== account.userId) {
      setCallStatus("Собеседник переносит звонок. Сохраняю соединение…");
    }
    return;
  }

  if (event.type === "call.answered") {
    if (isGroupCall(currentCall)) return;
    if (currentCall.status === "accepted") return;
    callProfiler.setMeta({ answerSource: "ws" }, activeProfileSessionId);
    callProfiler.mark("call_answered", activeProfileSessionId, { meta: "ws" });
    logCallEvent("звонок принят");
    stopRingback();
    playCallCue("answered");
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
    if (isGroupCall(currentCall)) {
      activeGroupCallsByChat.delete(currentCall.conversationId);
      renderGroupCallBanner();
    }
    finishCall("Звонок завершён.");
    announce("Звонок завершён.");
    return;
  }
  if (event.type === "call.signal" && event.signal) {
    if (recoveryPending) { logCallEvent("пауза сигналов"); return; }
    await enqueueSignal(event.signal);
    return;
  }
  if (event.type === "call.signals" && Array.isArray(event.signals)) {
    if (recoveryPending) { logCallEvent("пауза сигналов"); return; }
    for (const signal of event.signals) {
      if (signal && typeof signal === "object") await enqueueSignal(signal);
    }
  }
}

async function applyLocalDescriptionWithOpusTuning(pc, description) {
  const profileId = getSelectedAudioProfile().id;
  const tunedSdp = tuneOpusSdp(description.sdp, profileId);
  const tuned = tunedSdp !== description.sdp ? { type: description.type, sdp: tunedSdp } : description;
  try {
    await pc.setLocalDescription(tuned);
    return tuned;
  } catch {
    await pc.setLocalDescription(description);
    return description;
  }
}

async function beginOfferIfNeeded() {
  if (!currentCall || currentCall.direction !== "outgoing" || offerStarted || recoveryPending) return;
  const startingCallId = currentCall.callId;
  const profileSessionId = activeProfileSessionId;
  offerStarted = true;
  logCallEvent("начало согласования", "исходящее предложение");
  try {
    const pc = await ensurePeerConnection();
    if (currentCall?.callId !== startingCallId || pc !== peerConnection) return;
    localNegotiationId = crypto.randomUUID();
    callProfiler.mark("offer_create_start", profileSessionId);
    const rawOffer = await pc.createOffer();
    const offer = await applyLocalDescriptionWithOpusTuning(pc, rawOffer);
    callProfiler.mark("offer_local_set", profileSessionId);
    callProfiler.mark("offer_send_start", profileSessionId);
    await sendSignal("offer", { type: offer.type, sdp: offer.sdp, negotiationId: localNegotiationId });
    callProfiler.mark("offer_sent", profileSessionId);
    logCallEvent("SDP предложение", "отправлено");
  } catch (error) {
    if (currentCall?.callId !== startingCallId) return;
    offerStarted = false;
    logCallEvent("сигнал ошибка", `offer, ${String(error?.name || "network")}`);
    setCallStatus(`Не удалось создать аудиосоединение: ${error.message}`);
  }
}

async function restartOffer({ rebuild = false, refreshIce = true, automatic = false } = {}) {
  if (!currentCall || currentCall.direction !== "outgoing" || currentCall.status !== "accepted") return false;
  if (restartInFlight) return false;
  restartInFlight = true;
  try {
    const freshIceServers = refreshIce ? await getIceServers({ refresh: true }) : await getIceServers();
    let pc = peerConnection;

    if (rebuild || !pc || pc.signalingState !== "stable") {
      cleanupPeerConnection();
      remoteCandidates = [];
      pc = await ensurePeerConnection({ iceServers: freshIceServers });
    } else {
      try {
        const currentConfiguration = typeof pc.getConfiguration === "function" ? pc.getConfiguration() : {};
        pc.setConfiguration?.({ ...currentConfiguration, iceServers: freshIceServers });
      } catch {
        // Some browsers reject live ICE-server replacement. The existing routes can still be restarted.
      }
      try { pc.restartIce?.(); } catch {}
    }

    localNegotiationId = crypto.randomUUID();
    const rawOffer = await pc.createOffer({ iceRestart: true });
    const offer = await applyLocalDescriptionWithOpusTuning(pc, rawOffer);
    offerStarted = true;
    await sendSignal("offer", {
      type: offer.type,
      sdp: offer.sdp,
      recoveryMode: rebuild ? "rebuild" : "ice-restart",
      negotiationId: localNegotiationId
    });
    setCallStatus(rebuild
      ? "Перестраиваю аудиосоединение через свежий сетевой маршрут…"
      : "Восстанавливаю аудио без разрыва медиасессии…");
    return true;
  } catch (error) {
    offerStarted = false;
    if (!automatic) setCallStatus(`Не удалось восстановить аудиосоединение: ${error.message}`);
    return false;
  } finally {
    restartInFlight = false;
    // A radio coming back while an offer was being sent deserves an immediate
    // retry after that offer settles, never an overlapping second offer.
    if (pendingFastRecovery) {
      const pending = pendingFastRecovery;
      pendingFastRecovery = null;
      queueMicrotask(() => {
        if (currentCall?.callId === pending.callId && currentCall.status === "accepted" &&
            !recoveryPending && !isPeerConnected())
          void recoverCallConnection({ hard: pending.hard, reason: pending.reason });
      });
    }
  }
}

async function prefetchIceServers() {
  try {
    await getIceServers();
  } catch {
    // A later connection attempt still has the built-in STUN fallback.
  }
}

async function prewarmOutgoingPeerConnection() {
  if (!currentCall || currentCall.direction !== "outgoing" || currentCall.status !== "ringing" || !localStream || peerConnection) return;
  const ringingCallId = currentCall.callId;
  const profileSessionId = activeProfileSessionId;
  try {
    await ensurePeerConnection();
    callProfiler.mark("prewarm_pc_ready", profileSessionId);
    // Create and upload the caller's SDP offer + initial ICE/TURN candidates while
    // the callee's phone is still ringing. CallRoom stores them safely until
    // POST /answer and returns them immediately in the answer response.
    if (currentCall?.callId === ringingCallId && currentCall.status === "ringing" && !offerStarted && !recoveryPending) {
      await beginOfferIfNeeded();
    }
  } catch {
    // Prewarming is only a latency optimization. The normal offer path retries after answer.
  }
}

function createPeerConnectionWithRoutePool(iceServers) {
  const baseConfiguration = {
    iceServers,
    iceTransportPolicy: callIcePolicy(iceServers,isTemporaryTurnOnly())
  };
  try {
    return new RTCPeerConnection({
      ...baseConfiguration,
      iceCandidatePoolSize: ICE_CANDIDATE_POOL_SIZE
    });
  } catch {
    // Older WebKit builds may reject candidate pooling. Keep normal trickle ICE working.
    return new RTCPeerConnection(baseConfiguration);
  }
}

async function ensurePeerConnection(options = {}) {
  // Prewarming and the answer event can overlap while the TURN request
  // is pending. Without single-flight these create two competing peers.
  if (peerConnectionPromise) return peerConnectionPromise;
  if (peerConnection) return peerConnection;
  const epoch = peerCreationEpoch;
  const pending = createPeerConnection(options, epoch);
  peerConnectionPromise = pending;
  try {
    return await pending;
  } finally {
    if (peerConnectionPromise === pending) peerConnectionPromise = null;
  }
}

function disposePrewarmedIncoming() {
  if (!prewarmedIncoming) return;
  try { prewarmedIncoming.pc.close(); } catch {}
  prewarmedIncoming = null;
}

function prewarmIncomingPeerConnection(call) {
  if (!call || isGroupCall(call) || call.direction !== "incoming" || call.status !== "ringing") return;
  if (!currentCall || currentCall.callId !== call.callId || peerConnection || peerConnectionPromise) return;
  if (prewarmedIncoming?.callId === call.callId) return;
  if (!lastIceServers?.length || typeof RTCPeerConnection === "undefined") return;
  disposePrewarmedIncoming();
  try {
    const policy = callIcePolicy(lastIceServers, isTemporaryTurnOnly());
    const pc = createPeerConnectionWithRoutePool(lastIceServers);
    prewarmedIncoming = { callId: call.callId, pc, policy };
  } catch {
    prewarmedIncoming = null;
  }
}

function ensureAudioTransceiverSendRecv(pc) {
  if (!pc || typeof pc.getTransceivers !== "function") return null;
  const audioTransceiver = pc.getTransceivers().find(
    (item) => item?.receiver?.track?.kind === "audio" || item?.sender?.track?.kind === "audio"
  );
  if (audioTransceiver && audioTransceiver.direction !== "sendrecv") {
    try {
      audioTransceiver.direction = "sendrecv";
    } catch {
      // Some older implementations lock direction on closed/stopped transceivers.
    }
  }
  return audioTransceiver ?? null;
}

async function attachLocalStreamToPeerConnection(pc, stream, profileSessionId = null) {
  if (!pc || pc !== peerConnection || !stream || pc.signalingState === "closed") return false;
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return false;
  audioTrack.enabled = !muted;

  const transceivers = typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
  const audioTransceiver = transceivers.find(
    (item) => item?.receiver?.track?.kind === "audio" || item?.sender?.track?.kind === "audio"
  ) ?? null;
  const existingSender = audioTransceiver?.sender
    ?? (pc.getSenders?.() ?? []).find((candidate) => candidate.track?.kind === "audio" || !candidate.track)
    ?? null;

  if (existingSender?.track === audioTrack) return true;

  let sender = existingSender;
  if (sender && typeof sender.replaceTrack === "function") {
    try {
      await sender.replaceTrack(audioTrack);
      try { sender.setStreams?.(stream); } catch {}
      logDiagnostic("Звонки", "дорожка добавлена", "audio");
    } catch {
      sender = pc.addTrack(audioTrack, stream);
      logDiagnostic("Звонки", "дорожка добавлена", "audio");
    }
  } else {
    sender = pc.addTrack(audioTrack, stream);
    logDiagnostic("Звонки", "дорожка добавлена", "audio");
  }

  if (sender) {
    void tuneAudioSender(sender, undefined, { managedExternally: true }).catch(() => {});
  }
  if (profileSessionId) {
    callProfiler.mark("mic_attached", profileSessionId);
  }
  // If iOS CoreAudio route switching momentarily paused remote playback while
  // opening the microphone, immediately resume playback without user action.
  if (elements.callRemoteAudio?.srcObject && elements.callRemoteAudio.paused) {
    void elements.callRemoteAudio.play().catch(() => {});
  }
  // Safety check: if a browser failed to negotiate sendrecv before track attach,
  // request a seamless non-rebuilding renegotiation so remote hears our voice.
  if (audioTransceiver && audioTransceiver.currentDirection === "recvonly") {
    try { audioTransceiver.direction = "sendrecv"; } catch {}
    if (!recoveryPending) {
      void recoverCallConnection({ hard: false, reason: "mic-direction-upgrade" });
    }
  }
  return true;
}

async function createPeerConnection({ iceServers: providedIceServers = null, refreshIce = false, allowDeferredMic = false } = {}, epoch) {
  const profileSessionId = activeProfileSessionId;
  if (!localStream && !allowDeferredMic) localStream = await requestMicrophone();
  const iceServers = providedIceServers ?? await getIceServers({ refresh: refreshIce });
  if (epoch !== peerCreationEpoch) throw new Error("Создание устаревшего аудиосоединения отменено.");
  callProfiler.mark("pc_create_start", profileSessionId);
  const desiredPolicy = callIcePolicy(iceServers, isTemporaryTurnOnly());
  let pc = null;
  if (
    !refreshIce &&
    prewarmedIncoming &&
    prewarmedIncoming.callId === currentCall?.callId &&
    prewarmedIncoming.policy === desiredPolicy &&
    prewarmedIncoming.pc?.signalingState === "stable"
  ) {
    pc = prewarmedIncoming.pc;
    prewarmedIncoming = null;
  } else {
    disposePrewarmedIncoming();
    pc = createPeerConnectionWithRoutePool(iceServers);
  }
  relayCandidateSeen = false;
  const discoveredCandidateTypes = new Set();
  logCallEvent("новый WebRTC создан", `маршрут ${desiredPolicy}`);
  peerConnection = pc;
  setCallRouteAvailability(iceServers);

  if (localStream) {
    for (const track of localStream.getTracks()) {
      if (epoch !== peerCreationEpoch) {
        pc.close();
        throw new Error("Создание устаревшего аудиосоединения отменено.");
      }
      const sender = pc.addTrack(track, localStream);
      logDiagnostic('Звонки','дорожка добавлена',track.kind==='audio'?'audio':'другое');
      if (track.kind === "audio") {
        // Do not block SDP offer/answer creation waiting for sender encoder tuning.
        void tuneAudioSender(sender, undefined, { managedExternally: true }).catch(() => {});
      }
    }
  }
  callProfiler.mark("pc_created", profileSessionId);

  pc.addEventListener("icecandidate", (event) => {
    if (!currentCall || peerConnection !== pc) return;
    if (!event.candidate) {
      void iceBatcher.flushNow();
      return;
    }
    const candidate = event.candidate;
    const candidateType = /\btyp (host|srflx|prflx|relay)\b/.exec(candidate.candidate)?.[1] ?? "неизвестно";
    if (candidateType === "relay") relayCandidateSeen = true;
    callProfiler.mark("first_local_ice", profileSessionId, { meta: candidateType });
    callProfiler.setMeta({ firstLocalIceType: candidateType }, profileSessionId);
    if (!discoveredCandidateTypes.has(candidateType)) {
      discoveredCandidateTypes.add(candidateType);
      logCallEvent("ICE получен", candidateType);
    }
    iceBatcher.push({
      kind: "ice",
      payload: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment ?? null,
        negotiationId: currentCall.direction === "outgoing" ? localNegotiationId : remoteNegotiationId
      }
    });
  });
  pc.addEventListener("icecandidateerror", (event) => {
    const code = Number(event.errorCode);
    if (peerConnection === pc) logCallEvent("ICE ошибка", Number.isInteger(code) ? String(code) : "неизвестно");
  });
  pc.addEventListener("icegatheringstatechange", () => {
    if (peerConnection !== pc) return;
    logCallEvent("ICE состояние", `сбор ${pc.iceGatheringState}`);
    if (pc.iceGatheringState === "complete") {
      void iceBatcher.flushNow();
    }
    if (pc.iceGatheringState === "complete" && !discoveredCandidateTypes.has("relay") &&
        pc.getConfiguration?.().iceTransportPolicy === "relay") {
      logCallEvent("TURN не дал relay", "кандидаты не получены");
      setCallStatus("TURN не предоставил маршрут. Проверьте подключение к серверу TURN в этой сети.");
    }
  });
  pc.addEventListener("signalingstatechange", () => {
    if (peerConnection === pc) logCallEvent("состояние звонка", pc.signalingState);
  });
  pc.addEventListener("track", (event) => {
    if (peerConnection !== pc) return;
    callProfiler.mark("remote_track", profileSessionId);
    logCallEvent("SDP ответ", "удалённая аудиодорожка");
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    elements.callRemoteAudio.srcObject = stream;
    applyJitterBufferTarget(event.receiver, jitterController.targetMs);
    void Promise.resolve().then(() => elements.callRemoteAudio.play()).then(() => {
      if (peerConnection !== pc) return;
      remotePlaybackBlocked = false;
      if (!recoveryPending) elements.callResumeButton.hidden = true;
    }).catch(() => {
      if (peerConnection !== pc) return;
      remotePlaybackBlocked = true;
      logCallEvent("воспроизведение заблокировано", "нужно нажать включить звук");
      elements.callResumeButton.hidden = false;
      elements.callResumeButton.textContent = "Включить звук";
      setCallStatus("Соединение есть, но Safari заблокировал воспроизведение. Нажмите «Включить звук».");
    });
  });
  pc.addEventListener("connectionstatechange", () => {
    if (peerConnection !== pc) return;
    handlePeerConnectionState(pc);
  });
  pc.addEventListener("iceconnectionstatechange", () => {
    if (peerConnection !== pc) return;
    handleIceConnectionState(pc);
  });
  if (epoch !== peerCreationEpoch) {
    pc.close();
    throw new Error("Создание устаревшего аудиосоединения отменено.");
  }
  return pc;
}

function stopFirstAudioFrameProbe() {
  clearTimeout(firstAudioProbeTimer);
  firstAudioProbeTimer = null;
  firstAudioProbeAttempts = 0;
}

function logProfilerSummaryOnce(sessionId) {
  if (!sessionId || profileLoggedForSessionId === sessionId) return;
  const snapshot = callProfiler.getLatest();
  if (!snapshot || snapshot.id !== sessionId || snapshot.totalConnectMs === null) return;
  const summary = formatCallProfileCompact(snapshot);
  if (!summary) return;
  profileLoggedForSessionId = sessionId;
  logCallEvent("профайлер", summary);
}

function startFirstAudioFrameProbe(pc, sessionId) {
  stopFirstAudioFrameProbe();
  if (!pc || typeof pc.getStats !== "function" || !sessionId) {
    logProfilerSummaryOnce(sessionId);
    return;
  }
  const poll = async () => {
    firstAudioProbeTimer = null;
    if (peerConnection !== pc || activeProfileSessionId !== sessionId || pc.connectionState !== "connected") return;
    firstAudioProbeAttempts += 1;
    try {
      const stats = await pc.getStats();
      if (peerConnection !== pc || activeProfileSessionId !== sessionId) return;
      const route = selectedCallRoute(stats);
      if (route === "через TURN-сервер") callProfiler.setMeta({ route: "turn" }, sessionId);
      else if (route === "прямое соединение") callProfiler.setMeta({ route: "direct" }, sessionId);

      let rttMs = null;
      let inboundPackets = 0;
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && (report.nominated || report.state === "succeeded")) {
          if (typeof report.currentRoundTripTime === "number" && Number.isFinite(report.currentRoundTripTime)) {
            rttMs = report.currentRoundTripTime * 1000;
          }
        }
        const kind = report.kind ?? report.mediaType;
        if (report.type === "inbound-rtp" && kind === "audio" && !report.isRemote) {
          inboundPackets = Math.max(inboundPackets, Number(report.packetsReceived) || 0);
        }
      });
      if (rttMs !== null) callProfiler.setMeta({ rttMs }, sessionId);
      if (inboundPackets > 0) {
        callProfiler.mark("first_audio_frame", sessionId);
        logProfilerSummaryOnce(sessionId);
        return;
      }
    } catch {
      logProfilerSummaryOnce(sessionId);
      return;
    }
    if (firstAudioProbeAttempts < 50) {
      firstAudioProbeTimer = setTimeout(() => void poll(), 40);
    } else {
      logProfilerSummaryOnce(sessionId);
    }
  };
  void poll();
}

function handlePeerConnectionState(pc) {
  logCallEvent("WebRTC состояние", pc.connectionState);
  updateCallDiagnostics(pc);
  syncCallPollingCadence();
  if (pc.connectionState === "connected") {
    callProfiler.mark("pc_connected", activeProfileSessionId);
    startFirstAudioFrameProbe(pc, activeProfileSessionId);
    initialConnectionWatchdog.disarm();
    watchdogExtended = false;
    recoveryGate.reset();
    lastConnectedAt = Date.now();
    const recovered = networkRecoveryActive;
    clearAutomaticRecoveryTimers();
    recoveryAttempt = 0;
    networkRecoveryActive = false;
    applyJitterBufferToPeer(pc, jitterController.onConnected({ recovered }));
    if (recovered) {
      const audioSender = pc.getSenders?.().find((candidate) => candidate.track?.kind === "audio");
      if (audioSender) markBitrateNetworkRecovered(audioSender);
    }
    startQualityMonitoring(pc);
    setCallStatus(remotePlaybackBlocked
      ? "Браузер заблокировал воспроизведение. Нажмите «Включить звук»."
      : `Разговор идёт. Режим: ${getSelectedAudioProfile().label}.`);
    if (!audioConnectedOnce) {
      audioConnectedOnce = true;
      logCallEvent("звук соединён");
      playCallCue("connected");
      announce(`Аудиозвонок с ${currentCall?.peer?.displayName ?? "собеседником"} соединён.`);
    } else if (recovered) {
      announce("Связь восстановлена. Разговор продолжается.");
    }
    return;
  }

  if (pc.connectionState === "connecting") {
    callProfiler.mark("pc_connecting", activeProfileSessionId);
    setCallStatus(networkRecoveryActive ? "Восстанавливаю аудио…" : "Соединяю аудио…");
    return;
  }

  if (pc.connectionState === "disconnected") {
    raiseJitterBufferForNetworkStress(pc, "degraded");
    setCallStatus("Связь нестабильна. Ненадолго увеличиваю аудиобуфер и удерживаю разговор…");
    scheduleAutomaticRecovery(pc, "connection-disconnected");
    return;
  }

  if (pc.connectionState === "failed") {
    raiseJitterBufferForNetworkStress(pc, "severe");
    setCallStatus("Связь пропала. Автоматически восстанавливаю аудио через новый сетевой маршрут…");
    void recoverCallConnection({ hard: false, reason: "connection-failed" });
  }
}

function handleIceConnectionState(pc) {
  logCallEvent("ICE состояние", pc.iceConnectionState);
  if (pc.iceConnectionState === "checking") {
    callProfiler.mark("ice_checking", activeProfileSessionId);
  } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
    callProfiler.mark("ice_connected", activeProfileSessionId);
  }
  syncCallPollingCadence();
  if (pc.iceConnectionState === "disconnected") {
    raiseJitterBufferForNetworkStress(pc, "degraded");
    scheduleAutomaticRecovery(pc, "ice-disconnected");
  } else if (pc.iceConnectionState === "failed") {
    raiseJitterBufferForNetworkStress(pc, "severe");
    void recoverCallConnection({ hard: false, reason: "ice-failed" });
  }
}

function scheduleAutomaticRecovery(pc, reason) {
  if (disconnectRecoveryTimer || restartInFlight || recoveryPending) return;
  if (!currentCall || currentCall.status !== "accepted") return;
  disconnectRecoveryTimer = setTimeout(() => {
    disconnectRecoveryTimer = null;
    if (peerConnection !== pc || !currentCall || currentCall.status !== "accepted") return;
    const stillDisconnected = pc.connectionState === "disconnected" ||
      pc.connectionState === "failed" ||
      pc.iceConnectionState === "disconnected" ||
      pc.iceConnectionState === "failed";
    if (stillDisconnected) void recoverCallConnection({ hard: false, reason });
  }, DISCONNECT_RECOVERY_GRACE_MS);
}

async function recoverCallConnection({ hard, reason }) {
  if (!currentCall || currentCall.status !== "accepted" || recoveryPending) return;
  if (restartInFlight || !recoveryGate.admit(currentCall.callId)) {
    logCallEvent("восстановление пропущено", "ожидаю текущую попытку");
    return;
  }

  clearTimeout(disconnectRecoveryTimer);
  disconnectRecoveryTimer = null;
  networkRecoveryActive = true;
  recoveryAttempt = hard ? Math.max(2, recoveryAttempt + 1) : Math.max(recoveryAttempt, 1);
  logCallEvent("восстановление", `попытка ${recoveryAttempt}, ${hard ? "пересоздание" : "обновление ice"}`);
  raiseJitterBufferForNetworkStress(peerConnection, hard ? "severe" : "degraded");
  setCallStatus(hard
    ? "Первый маршрут не восстановился. Перестраиваю соединение и обновляю STUN/TURN…"
    : "Сеть прервалась. Обновляю STUN/TURN и восстанавливаю звонок автоматически…");

  try {
    if (currentCall.direction === "outgoing") {
      // Reuse fresh TURN credentials on the first soft ICE restart so slow
      // links don't stall for 1.5-6.5s re-fetching /api/v1/calls/ice.
      const shouldRefreshIce = hard || !hasFreshTurnCache();
      await restartOffer({ rebuild: hard, refreshIce: shouldRefreshIce, automatic: true });
    } else {
      await sendSignal("resume", {
        reason,
        mode: hard ? "rebuild" : "ice-restart"
      });
    }
  } catch {
    // The network may still be completely offline. The watchdog retries with a fresh route.
  } finally {
    armRecoveryWatchdog();
  }
}

function armRecoveryWatchdog() {
  clearTimeout(recoveryWatchdogTimer);
  recoveryWatchdogTimer = setTimeout(() => {
    recoveryWatchdogTimer = null;
    if (!currentCall || currentCall.status !== "accepted" || recoveryPending) return;
    if (isPeerConnected()) {
      clearAutomaticRecoveryTimers();
      recoveryAttempt = 0;
      networkRecoveryActive = false;
      return;
    }
    // Do not strand an active call in a manual retry loop. If the radio went
    // offline, the "online" handler will resume; otherwise renegotiate on
    // a fresh ICE route with bounded pacing until sound returns or call ends.
    if (navigator.onLine === false) {
      setCallStatus("Соединение с интернетом отсутствует. Автоматически продолжу после подключения.");
      return;
    }
    if (recoveryAttempt >= 3 && !hasTurnRelay()) {
      // ICE restarts cannot punch through every symmetric NAT without TURN.
      // Warn honestly and avoid repeatedly tearing down a route on unchanged
      // connectivity. Still retry on a slower cadence and immediately online.
      setCallStatus("Прямое соединение не устанавливается, резервный TURN-сервер пока не настроен. Ожидаю новый сетевой маршрут…");
      recoveryWatchdogTimer = setTimeout(() => {
        recoveryWatchdogTimer = null;
        if (currentCall?.status === "accepted" && !recoveryPending && !isPeerConnected())
          void recoverCallConnection({ hard: true, reason: "stun-only-retry" });
      }, 35_000);
      return;
    }
    setCallStatus("Звук пока не вернулся. Проверяю новое соединение автоматически, звонок сохраняется…");
    void recoverCallConnection({ hard: true, reason: "recovery-watchdog" });
  }, RECOVERY_WATCHDOG_MS);
}

function hasTurnRelay() {
  return (lastIceServers ?? []).some(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => typeof url === "string" && /^turns?:/i.test(url));
  });
}

function isPeerConnected() {
  if (isGroupCall(currentCall)) {
    if (!groupPeers.size) return true;
    for (const entry of groupPeers.values()) {
      const state = entry.pc?.connectionState;
      const iceState = entry.pc?.iceConnectionState;
      if (state !== "connected" && iceState !== "connected" && iceState !== "completed") return false;
    }
    return true;
  }
  return peerConnection?.connectionState === "connected" || peerConnection?.iceConnectionState === "connected" ||
    peerConnection?.iceConnectionState === "completed";
}

function clearAutomaticRecoveryTimers() {
  clearTimeout(disconnectRecoveryTimer);
  clearTimeout(recoveryWatchdogTimer);
  disconnectRecoveryTimer = null;
  recoveryWatchdogTimer = null;
}

function startQualityMonitoring(pc) {
  stopQualityMonitoring();
  qualityMonitorTimer = setInterval(() => void sampleInboundAudioQuality(pc), QUALITY_SAMPLE_MS);
  void sampleInboundAudioQuality(pc);
}

function stopQualityMonitoring() {
  clearInterval(qualityMonitorTimer);
  qualityMonitorTimer = null;
  lastInboundAudioStats = null;
  lastSelectedCallRoute = null;
}

async function sampleInboundAudioQuality(pc) {
  if (peerConnection !== pc || pc.connectionState !== "connected" || typeof pc.getStats !== "function") return;
  try {
    const stats = await pc.getStats();
    const audioSender = pc.getSenders?.().find((candidate) => candidate.track?.kind === "audio");
    if (audioSender) {
      void stepAdaptiveBitrateWithStats(audioSender, getSelectedAudioProfile(), stats);
    }
    if (peerConnection === pc && currentCall) {
      elements.callDiagnosticsText.textContent = describeCallDiagnostics(pc, stats);
      const selected = selectedCallRoute(stats);
      if (selected !== lastSelectedCallRoute && selected !== "определяется") {
        lastSelectedCallRoute = selected;
        logCallEvent("проверка качества", selected === "через TURN-сервер" ? "маршрут turn" : "маршрут прямой");
      }
    }
    let inbound = null;
    stats.forEach((report) => {
      const kind = report.kind ?? report.mediaType;
      if (!inbound && report.type === "inbound-rtp" && kind === "audio" && !report.isRemote) inbound = report;
    });
    if (!inbound) return;

    const current = {
      id: inbound.id,
      packetsReceived: Number(inbound.packetsReceived) || 0,
      packetsLost: Number(inbound.packetsLost) || 0,
      jitterMs: Math.max(0, (Number(inbound.jitter) || 0) * 1000)
    };
    const previous = lastInboundAudioStats;
    lastInboundAudioStats = current;
    if (!previous || previous.id !== current.id) return;

    const receivedDelta = Math.max(0, current.packetsReceived - previous.packetsReceived);
    const lostDelta = Math.max(0, current.packetsLost - previous.packetsLost);
    const packetDelta = receivedDelta + lostDelta;
    const lossRate = packetDelta > 0 ? lostDelta / packetDelta : 0;

    const transition = jitterController.onStatsSample({
      lossRate,
      jitterMs: current.jitterMs,
      packetDelta
    });
    applyJitterBufferToPeer(pc, transition);
  } catch {
    // getStats and jitterBufferTarget are optional enhancements; WebRTC keeps its own jitter buffer without them.
  }
}

function raiseJitterBufferForNetworkStress(pc, severity) {
  if (!pc) return;
  const transition = jitterController.onNetworkStress(severity);
  applyJitterBufferToPeer(pc, transition);
}

function applyJitterBufferToPeer(pc, transition) {
  if (!transition) return;
  if (transition.changed) {
    logCallEvent("буфер звука", formatJitterBufferLabel(transition.targetMs));
  }
  for (const receiver of pc?.getReceivers?.() ?? []) {
    if (receiver.track?.kind === "audio") {
      applyJitterBufferTarget(receiver, transition.targetMs);
    }
  }
}

function applyAudioProfileDuringCall() {
  const epoch = ++profileSwitchEpoch;
  const profile = getSelectedAudioProfile();
  // Queuing rather than racing gUM requests avoids Android's old settings
  // appearing to apply only on the *next* quality change.
  profileSwitchQueue = profileSwitchQueue.catch(() => {}).then(async () => {
    if (epoch !== profileSwitchEpoch) return;
    const oldStream = localStream;
    const track = oldStream?.getAudioTracks?.()[0];
    if (!track || !currentCall) return;
    const callId = currentCall.callId;
    const pc = peerConnection;
    const primarySender = pc?.getSenders?.().find((candidate) => candidate.track?.kind === "audio");
    const groupSenders = [...groupPeers.values()]
      .map((entry) => entry.pc?.getSenders?.().find((candidate) => candidate.track?.kind === "audio"))
      .filter(Boolean);
    const sender = primarySender ?? groupSenders[0] ?? null;
    logDiagnostic("Микрофон", "переключение в звонке", profile.id);
    const trace = (stage, detail = "") => logDiagnostic("Микрофон", stage, detail);
    try {
      const switchResult = await switchCallAudioProfile({
        oldStream, sender,
        acquire: () => requestCallMicrophone(profile.id),
        applyExisting: (oldTrack) => applySelectedAudioProfileToTrack(oldTrack, profile.id),
        isCurrent: () => epoch === profileSwitchEpoch && currentCall?.callId === callId &&
          peerConnection === pc && localStream === oldStream,
        muted, trace
      });
      if (switchResult.status === "stale") { trace("переключение пропущено"); return; }
      if (switchResult.captureError) logDiagnostic("Микрофон", "новая дорожка недоступна", switchResult.captureError);
      if (switchResult.status === "failed") {
        logDiagnostic("Микрофон", "ошибка переключения", switchResult.fallbackError);
        announce(`Не удалось переключить режим «${profile.label}». Предыдущий звук сохранён.`);
        return;
      }
      if (switchResult.status === "replaced") {
        localStream = switchResult.stream;
        attachLocalTrackListeners(localStream);
        // Replace the track on all additional group call peer senders too.
        for (const extraSender of groupSenders) {
          if (extraSender !== sender && typeof extraSender.replaceTrack === "function") {
            try { await extraSender.replaceTrack(switchResult.track); } catch {}
          }
        }
      }
      const result = switchResult.status === "replaced"
        ? updateAudioProfileStatus(switchResult.track, profile.id)
        : switchResult.result;
      if (epoch !== profileSwitchEpoch || currentCall?.callId !== callId) return;
      const allSenders = [...new Set([primarySender, ...groupSenders].filter(Boolean))];
      for (const activeSender of allSenders) {
        trace("настройка кодировщика начало");
        try {
          await tuneAudioSender(activeSender, profile.id, { managedExternally: true });
          trace("настройка кодировщика успешно");
        } catch (error) {
          trace("настройка кодировщика ошибка", diagnosticErrorName(error));
        }
      }
      const partial = switchResult.status === "fallback" || result?.mismatches?.length || result?.unknown?.length;
      logDiagnostic("Микрофон", partial ? "режим применён частично" : "режим применён", profile.id);
      announce(partial
        ? `Режим «${profile.label}» применён к действующему микрофону, но браузер не подтвердил все параметры.`
        : `Режим звука «${profile.label}» применён к текущему микрофону.`);
    } catch (error) {
      trace("непредвиденная ошибка переключения", mediaErrorCategory(error));
      logDiagnostic("Микрофон", "ошибка переключения", mediaErrorCategory(error));
      if (currentCall?.callId === callId) announce(`Не удалось переключить режим звука во время звонка: ${friendlyMediaError(error)}.`);
    }
  });
  return profileSwitchQueue;
}

async function sendSignal(kind, payload, { targetUserId = null } = {}) {
  if (!currentCall) return;
  // Capture the current call so an old request cannot mutate the next one's cursor.
  const sendingCallId = currentCall.callId;
  const path = callPath("/signals");
  const retries = kind === "ice" ? 1 : 2;
  const body = targetUserId ? { kind, payload, targetUserId } : { kind, payload };
  const signal = ensureCallAbortSignal();
  try {
    const result = await api(path, {
      method: "POST",
      retries,
      signal,
      body: JSON.stringify(body)
    });
    if (currentCall?.callId !== sendingCallId) return;
    if (result.signal?.sequence) processedSignalSequences.add(result.signal.sequence);
    if (kind !== "ice") logCallEvent("сигнал отправлен", kind);
  } catch (error) {
    if (currentCall?.callId !== sendingCallId && error?.name === "AbortError") return;
    if (currentCall?.callId === sendingCallId)
      logCallEvent("сигнал ошибка", `${kind}, ${String(error?.name || "network")}`);
    throw error;
  }
}

async function flushIceCandidateBatch(signals) {
  if (!currentCall || !Array.isArray(signals) || !signals.length) return;
  const profileSessionId = activeProfileSessionId;
  const markedFlush = callProfiler.mark("first_ice_flush_start", profileSessionId, { meta: String(signals.length) });
  if (markedFlush) callProfiler.setMeta({ firstIceBatchSize: signals.length }, profileSessionId);
  if (signals.length === 1) {
    try {
      await sendSignal("ice", signals[0].payload);
      if (markedFlush) callProfiler.mark("first_ice_flush_done", profileSessionId);
    } catch {
      // Already logged by sendSignal; a closed call or offline radio may reject late candidates.
    }
    return;
  }
  const sendingCallId = currentCall.callId;
  const path = callPath("/signals");
  try {
    const result = await api(path, {
      method: "POST",
      retries: 1,
      signal: ensureCallAbortSignal(),
      body: JSON.stringify({ signals })
    });
    if (markedFlush) callProfiler.mark("first_ice_flush_done", profileSessionId);
    if (currentCall?.callId !== sendingCallId) return;
    for (const signal of result.signals ?? []) {
      if (signal?.sequence) processedSignalSequences.add(signal.sequence);
    }
  } catch (error) {
    if (currentCall?.callId === sendingCallId && error?.name !== "AbortError")
      logCallEvent("сигнал ошибка", `ice, ${String(error?.name || "network")}`);
  }
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

function enqueueSignal(signal) {
  const job = signalProcessingQueue.then(() => processSignal(signal));
  signalProcessingQueue = job.then(() => {}, () => {});
  return job;
}

async function processSignal(signal) {
  if (!currentCall || signal.callId !== currentCall.callId) return true;
  if (signal.senderUserId === account?.userId || processedSignalSequences.has(signal.sequence)) return true;
  if (isGroupCall(currentCall)) {
    return processGroupSignal(signal);
  }
  const processingCallId = currentCall.callId;
  if (signal.kind !== "ice") logCallEvent("сигнал получен", signal.kind);
  try {
    if (signal.kind === "resume") {
      if (currentCall.direction === "outgoing" && !recoveryPending) {
        const hard = signal.payload?.mode === "rebuild";
        const createdAt = Number(signal.createdAt) || 0;
        const isStaleDuringHealthyCall = isPeerConnected() && !(
          hard && createdAt > lastConnectedAt + 3_000
        );
        if (isStaleDuringHealthyCall) {
          logCallEvent("восстановление пропущено", "соединение уже активно");
        } else {
          await recoverCallConnection({
            hard,
            reason: typeof signal.payload?.reason === "string" ? signal.payload.reason : "peer-reconnect"
          });
        }
      }
      processedSignalSequences.add(signal.sequence);
      return true;
    }

    const recoveryMode = signal.payload?.recoveryMode;
    const profileSessionId = activeProfileSessionId;
    if (signal.kind === "offer") callProfiler.mark("offer_received", profileSessionId);
    else if (signal.kind === "answer") callProfiler.mark("answer_received", profileSessionId);
    else if (signal.kind === "ice") callProfiler.mark("first_remote_ice", profileSessionId);
    let pc = await ensurePeerConnection();
    if (currentCall?.callId !== processingCallId || pc !== peerConnection) return true;
    if (signal.kind === "offer") {
      const incomingNegotiation = signal.payload?.negotiationId ?? null;
      // A repeated WebSocket + polling delivery must not rebuild twice.
      if (incomingNegotiation && incomingNegotiation === remoteNegotiationId &&
          pc.remoteDescription?.sdp === signal.payload.sdp) {
        processedSignalSequences.add(signal.sequence);
        return true;
      }
      if (recoveryMode === "rebuild") {
        const pendingCandidates = remoteCandidates;
        cleanupPeerConnection();
        remoteCandidates = pendingCandidates;
        pc = await ensurePeerConnection({ refreshIce: true });
      } else if (pc.signalingState !== "stable") {
        const pendingCandidates = remoteCandidates;
        cleanupPeerConnection();
        remoteCandidates = pendingCandidates;
        pc = await ensurePeerConnection();
      }
      remoteNegotiationId = incomingNegotiation;
      await pc.setRemoteDescription({ type: signal.payload.type, sdp: signal.payload.sdp });
      callProfiler.mark("offer_remote_set", profileSessionId);
      logCallEvent("SDP предложение", "принято");
      // Ensure bidirectional audio is negotiated even if iOS microphone capture is
      // still initializing in parallel; replaceTrack attaches the mic seamlessly.
      ensureAudioTransceiverSendRecv(pc);
      if (localStream) {
        await attachLocalStreamToPeerConnection(pc, localStream, profileSessionId);
      }
      callProfiler.mark("answer_create_start", profileSessionId);
      const rawAnswer = await pc.createAnswer();
      const answer = await applyLocalDescriptionWithOpusTuning(pc, rawAnswer);
      callProfiler.mark("answer_local_set", profileSessionId);
      callProfiler.mark("answer_send_start", profileSessionId);
      // Do not stall SDP answer upload behind remote addIceCandidate calls:
      // transmit SDP answer and inject queued remote ICE candidates concurrently.
      const sendAnswerPromise = sendSignal("answer", {
        type: answer.type,
        sdp: answer.sdp,
        negotiationId: remoteNegotiationId
      });
      const flushIcePromise = flushRemoteCandidates();
      await sendAnswerPromise;
      callProfiler.mark("answer_sent", profileSessionId);
      logCallEvent("SDP ответ", "отправлен");
      await flushIcePromise;
      showConnectedControls("Соединяю аудио…");
      processedSignalSequences.add(signal.sequence);
      return true;
    }
    if (signal.kind === "answer") {
      if (signal.payload?.negotiationId && signal.payload.negotiationId !== localNegotiationId) {
        processedSignalSequences.add(signal.sequence);
        return true;
      }
      await pc.setRemoteDescription({ type: signal.payload.type, sdp: signal.payload.sdp });
      callProfiler.mark("answer_remote_set", profileSessionId);
      logCallEvent("SDP ответ", "получен");
      await flushRemoteCandidates();
      processedSignalSequences.add(signal.sequence);
      return true;
    }
    if (signal.kind === "ice") {
      const generation = signal.payload?.negotiationId;
      const currentGeneration = currentCall.direction === "outgoing" ? localNegotiationId : remoteNegotiationId;
      const disposition = classifyIceCandidate(
        generation, currentGeneration, currentCall.direction === "incoming"
      );
      if (disposition === "ignore") {
        logCallEvent("сигнал проигнорирован", "старый ice");
        processedSignalSequences.add(signal.sequence);
        return true;
      }
      if (disposition === "queue" || !pc.remoteDescription) {
        remoteCandidates.push(signal.payload);
        if (remoteCandidates.length > 128) remoteCandidates.splice(0, remoteCandidates.length - 128);
      } else {
        await pc.addIceCandidate(signal.payload);
      }
    }
    processedSignalSequences.add(signal.sequence);
    return true;
  } catch (error) {
    if (currentCall?.callId !== processingCallId) return true;
    logCallEvent("сигнал ошибка", `${signal.kind}, ${String(error?.name || "network")}`);
    // Leave rejected offer/answer unprocessed so polling can try again
    // after the browser becomes ready. Do not advance the signaling cursor.
    setCallStatus(`Ошибка согласования аудио: ${error.message}`);
    return false;
  }
}

async function flushRemoteCandidates() {
  const pc = peerConnection;
  if (!pc?.remoteDescription) return;
  const queued = remoteCandidates;
  if (!queued.length) return;
  remoteCandidates = [];
  const expected = currentCall?.direction === "outgoing" ? localNegotiationId : remoteNegotiationId;
  const relevant = queued.filter((candidate) => !candidate.negotiationId || !expected || candidate.negotiationId === expected);
  if (!relevant.length) return;
  await Promise.allSettled(
    relevant.map((candidate) =>
      pc.addIceCandidate(candidate).catch((error) => {
        if (peerConnection === pc) logCallEvent("ICE ошибка", String(error?.name || "candidate"));
      })
    )
  );
}

function syncCallPollingCadence({ immediateSignals = false, immediateState = false } = {}) {
  if (!currentCall) {
    stopCallPolling();
    return;
  }
  const { signalMs, stateMs } = computeCallPollingIntervals({
    status: currentCall.status,
    peerConnected: isPeerConnected(),
    realtimeOpen: realtimeConnected(),
    recoveryPending
  });

  if (signalMs !== activeSignalPollMs) {
    clearInterval(signalPollTimer);
    signalPollTimer = null;
    activeSignalPollMs = signalMs;
    if (signalMs) {
      signalPollTimer = setInterval(() => void pollSignals(), signalMs);
    }
  }
  if (stateMs !== activeStatePollMs) {
    clearInterval(statePollTimer);
    statePollTimer = null;
    activeStatePollMs = stateMs;
    if (stateMs) {
      statePollTimer = setInterval(() => void pollCallState(), stateMs);
    }
  }

  if (immediateSignals && signalMs) void pollSignals();
  if (immediateState && stateMs) void pollCallState();
}

function startCallPolling() {
  stopCallPolling();
  if (!currentCall) return;
  syncCallPollingCadence({ immediateSignals: true, immediateState: true });
}

function startStatePolling() {
  if (!currentCall) return;
  syncCallPollingCadence({ immediateState: true });
}

function stopCallPolling() {
  clearInterval(signalPollTimer);
  clearInterval(statePollTimer);
  signalPollTimer = null;
  statePollTimer = null;
  activeSignalPollMs = null;
  activeStatePollMs = null;
  statePollRequestId += 1;
  statePollInFlight = false;
}

async function pollSignals() {
  if (!currentCall || currentCall.status !== "accepted" || recoveryPending || signalPollInFlight) return;
  signalPollInFlight = true;
  const requestId = ++signalPollRequestId;
  try {
    const callId = currentCall.callId;
    const result = await api(`${callPath("/signals")}?after=${signalPollCursor}`, {
      signal: ensureCallAbortSignal()
    });
    if (currentCall?.callId !== callId) return;
    for (const signal of result.signals ?? []) {
      if (currentCall?.callId !== callId || recoveryPending) break;
      const processed = await enqueueSignal(signal);
      if (!processed) break;
      signalPollCursor = Math.max(signalPollCursor, Number(signal.sequence) || 0);
    }
  } catch (error) {
    // The single foreground reconnect is handled separately; do not log every polling tick.
    if (currentCall?.status === "accepted" && error?.name !== "AbortError")
      logCallEvent("ошибка опроса", String(error?.name || "network"));
  } finally {
    if (signalPollRequestId === requestId) signalPollInFlight = false;
  }
}

async function pollCallState() {
  // Network requests on a congested 2G connection may take longer than the
  // polling interval. Do not stack duplicate GETs that starve SDP/ICE posts.
  if (!currentCall || statePollInFlight) return;
  statePollInFlight = true;
  const requestId = ++statePollRequestId;
  const polledCallId = currentCall.callId;
  const path = callPath();
  try {
    const result = await api(path, { signal: ensureCallAbortSignal() });
    const latest = result.call;
    if (!matchesCallResponse(currentCall, polledCallId, latest)) return;

    if (latest.status === "accepted" && currentCall.status === "ringing") {
      callProfiler.setMeta({ answerSource: "poll" }, activeProfileSessionId);
      callProfiler.mark("call_answered", activeProfileSessionId, { meta: "poll" });
      stopRingback();
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

    if (latest.status === "accepted" && currentCall.sessionOwnerId
      && latest.sessionOwnerId && latest.sessionOwnerId !== getCurrentSession()?.sessionId
      && !recoveryPending) {
      finishCall("Звонок перенесён на другое ваше устройство.");
      return;
    }
    const wasGroup = isGroupCall(currentCall);
    currentCall = { ...currentCall, ...latest };
    if (wasGroup) {
      if (latest.status === "ended") {
        activeGroupCallsByChat.delete(latest.conversationId);
        renderGroupCallBanner();
        finishCall("Групповой звонок завершён.");
        return;
      }
      rememberActiveGroupCall(currentCall);
      renderGroupCallBanner();
      renderCallParticipants();
      if (currentCall.joined && !recoveryPending) {
        await syncGroupPeers();
      }
      return;
    }
    if (latest.status === "declined") finishCall("Собеседник отклонил звонок.");
    else if (latest.status === "ended") finishCall("Звонок завершён.");
  } catch {
    // The WebSocket event and next successful poll can still recover state.
  } finally {
    if (requestId === statePollRequestId) statePollInFlight = false;
  }
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

async function getIceServers({ refresh = false } = {}) {
  clearTimeout(icePrefetchTimer);
  icePrefetchTimer = null;
  const profileSessionId = activeProfileSessionId;
  const cacheFresh = !refresh && lastIceServers && (Date.now() - iceServersFetchedAt) < ICE_CACHE_TTL_MS;
  if (cacheFresh) {
    callProfiler.setMeta({ iceCacheHit: true, iceHasTurn: turnAvailable(lastIceServers) }, profileSessionId);
    setCallRouteAvailability(lastIceServers);
    return lastIceServers;
  }
  if (refresh || (iceServersFetchedAt > 0 && (Date.now() - iceServersFetchedAt) >= ICE_CACHE_TTL_MS)) {
    iceRequestEpoch.invalidate();
    iceServersPromise = null;
  }
  if (!iceServersPromise) {
    const requestToken = iceRequestEpoch.token();
    logCallEvent("запрос TURN", "обновление серверов");
    callProfiler.mark("ice_fetch_start", profileSessionId);
    iceServersPromise = api("/api/v1/calls/ice")
      .then((result) => {
        if (!iceRequestEpoch.isCurrent(requestToken)) return FALLBACK_ICE_SERVERS;
        const servers = Array.isArray(result.iceServers) ? result.iceServers : [];
        if (servers.length) {
          lastIceServers = servers;
          iceServersFetchedAt = Date.now();
        }
        const resolved = lastIceServers ?? FALLBACK_ICE_SERVERS;
        callProfiler.mark("ice_fetch_done", profileSessionId);
        callProfiler.setMeta({ iceCacheHit: false, iceHasTurn: turnAvailable(resolved) }, profileSessionId);
        setCallRouteAvailability(resolved);
        return resolved;
      })
      .catch((error) => {
        if (!iceRequestEpoch.isCurrent(requestToken)) return FALLBACK_ICE_SERVERS;
        iceServersPromise = null;
        callProfiler.mark("ice_fetch_done", profileSessionId, { meta: "error" });
        callProfiler.setMeta({ iceCacheHit: false, iceHasTurn: turnAvailable(lastIceServers ?? FALLBACK_ICE_SERVERS) }, profileSessionId);
        logCallEvent("TURN недоступен", String(error?.name || "network"));
        return lastIceServers ?? FALLBACK_ICE_SERVERS;
      });
  }
  return iceServersPromise;
}

function callPath(suffix = "") {
  if (!currentCall?.conversationId || !currentCall?.callId) throw new Error("Звонок ещё не создан.");
  return `/api/v1/chats/${encodeURIComponent(currentCall.conversationId)}/calls/${encodeURIComponent(currentCall.callId)}${suffix}`;
}

async function requestMicrophone() {
  const stream = await requestCallMicrophone();
  // Keep the caller muted even if iOS replaces a capture track on recovery.
  if (muted) for (const track of stream.getAudioTracks()) track.enabled = false;
  attachLocalTrackListeners(stream);
  return stream;
}

function attachLocalTrackListeners(stream) {
  for (const track of stream?.getAudioTracks?.() ?? []) {
    if (typeof track.addEventListener !== "function") continue;
    track.addEventListener("ended", () => {
      if (!currentCall || localStream !== stream || recoveryPending) return;
      logDiagnostic("Микрофон", "дорожка микрофона завершилась");
      void recoverLocalMicrophoneTrack();
    });
  }
}

async function recoverLocalMicrophoneTrack() {
  if (localTrackRecovering || !currentCall || recoveryPending) return;
  const targetCallId = currentCall.callId;
  localTrackRecovering = true;
  try {
    const freshStream = await requestCallMicrophone();
    if (currentCall?.callId !== targetCallId) {
      for (const track of freshStream.getTracks()) track.stop();
      return;
    }
    const freshTrack = freshStream.getAudioTracks()[0];
    if (!freshTrack) return;
    freshTrack.enabled = !muted;
    const oldStream = localStream;
    localStream = freshStream;
    attachLocalTrackListeners(freshStream);
    const allPcs = [peerConnection, ...[...groupPeers.values()].map((entry) => entry.pc)].filter(Boolean);
    for (const pc of allPcs) {
      const sender = pc.getSenders?.().find((candidate) => candidate.track?.kind === "audio" || !candidate.track);
      if (sender && typeof sender.replaceTrack === "function") {
        try {
          await sender.replaceTrack(freshTrack);
          await tuneAudioSender(sender, undefined, { managedExternally: true });
        } catch {}
      }
    }
    if (oldStream && oldStream !== freshStream) {
      for (const oldTrack of oldStream.getTracks()) oldTrack.stop();
    }
    logDiagnostic("Микрофон", "микрофон восстановлен");
  } catch (error) {
    logDiagnostic("Микрофон", "ошибка восстановления микрофона", mediaErrorCategory(error));
  } finally {
    localTrackRecovering = false;
  }
}

function rememberActiveGroupCall(call) {
  if (!call || call.kind !== "group" || !call.conversationId) return;
  if (call.status === "accepted") {
    activeGroupCallsByChat.set(call.conversationId, {
      callId: call.callId,
      conversationId: call.conversationId,
      groupTitle: call.groupTitle || call.peer?.displayName || "Группа",
      avatarIcon: call.avatarIcon || "👥",
      participantCount: call.participantCount ?? call.participants?.length ?? 0,
      participants: call.participants ?? []
    });
  } else {
    activeGroupCallsByChat.delete(call.conversationId);
  }
}

async function refreshActiveGroupCallForChat(conversationId) {
  if (!account || !conversationId) return;
  try {
    const result = await api(`/api/v1/chats/${encodeURIComponent(conversationId)}/calls/active`);
    if (result.call && result.call.kind === "group" && result.call.status === "accepted") {
      rememberActiveGroupCall(result.call);
    } else {
      activeGroupCallsByChat.delete(conversationId);
    }
    renderGroupCallBanner();
    syncCallButton();
  } catch {
    // Ignore transient lookup errors; realtime updates will refresh the banner.
  }
}

function renderGroupCallBanner() {
  if (!elements.groupCallBanner) return;
  const active = selectedGroupChatId ? activeGroupCallsByChat.get(selectedGroupChatId) : null;
  const alreadyInThisCall = Boolean(currentCall && currentCall.conversationId === selectedGroupChatId && currentCall.joined !== false);
  if (!active || alreadyInThisCall || !account) {
    elements.groupCallBanner.hidden = true;
    return;
  }
  elements.groupCallBanner.hidden = false;
  if (elements.groupCallBannerTitle) {
    elements.groupCallBannerTitle.textContent = translateText(buildGroupCallBannerText(active));
  }
  if (elements.groupCallBannerMeta) {
    const names = (active.participants ?? []).map((entry) => entry.displayName).filter(Boolean).slice(0, 4);
    elements.groupCallBannerMeta.textContent = names.length ? names.join(", ") : "";
  }
  if (elements.groupCallJoinButton) {
    elements.groupCallJoinButton.disabled = Boolean(currentCall);
  }
}

function groupCallStatusText() {
  if (!currentCall || !isGroupCall(currentCall)) return "";
  if (isAnyRemoteAudioBlocked()) {
    return "Браузер заблокировал воспроизведение. Нажмите «Включить звук».";
  }
  const count = currentCall.participants?.length ?? 1;
  if (count <= 1) {
    return `Ожидаем участников… Режим: ${getSelectedAudioProfile().label}.`;
  }
  return `В звонке: ${formatParticipantCount(count)}. Режим: ${getSelectedAudioProfile().label}.`;
}

function renderCallParticipants() {
  if (!elements.callParticipantsSection || !elements.callParticipantsList) return;
  if (!currentCall || !isGroupCall(currentCall)) {
    elements.callParticipantsSection.hidden = true;
    elements.callParticipantsList.replaceChildren();
    if (elements.callEndAllButton) elements.callEndAllButton.hidden = true;
    return;
  }
  const list = Array.isArray(currentCall.participants) ? currentCall.participants : [];
  elements.callParticipantsSection.hidden = !list.length;
  elements.callParticipantsList.replaceChildren();
  for (const participant of list) {
    const isSelf = participant.userId === account?.userId;
    const peerEntry = groupPeers.get(participant.userId);
    const connectionState = isSelf
      ? "connected"
      : (peerEntry?.pc?.connectionState || "connecting");
    const isMuted = isSelf ? muted : Boolean(participant.muted);

    const item = document.createElement("li");
    item.className = "call-participant-item";
    if (isMuted) item.classList.add("is-muted");
    item.dataset.userId = participant.userId;

    const name = document.createElement("span");
    name.className = "call-participant-name";
    name.dataset.userContent = "true";
    name.textContent = isSelf ? `${participant.displayName} (${translateText("вы")})` : participant.displayName;

    const state = document.createElement("span");
    state.className = "call-participant-state";
    const statusText = isSelf
      ? translateText(isMuted ? "микрофон выключен" : "микрофон включён")
      : translateText(
          connectionState === "connected"
            ? (isMuted ? "на связи · без микрофона" : "на связи")
            : connectionState === "failed" || connectionState === "disconnected"
              ? (isMuted ? "переподключается · без микрофона" : "переподключается")
              : (isMuted ? "соединяется · без микрофона" : "соединяется")
        );
    state.textContent = statusText;

    item.setAttribute(
      "aria-label",
      translateText(formatParticipantStatus({
        displayName: participant.displayName,
        muted: isMuted,
        connectionState,
        isSelf
      }))
    );
    item.append(name, state);
    elements.callParticipantsList.append(item);
  }
  const canEndAll = Boolean(
    currentCall.joined &&
    currentCall.callerUserId === account?.userId &&
    list.length > 1
  );
  if (elements.callEndAllButton) elements.callEndAllButton.hidden = !canEndAll;
}

async function syncGroupPeers({ forceRenegotiate = false } = {}) {
  if (!currentCall || !isGroupCall(currentCall) || !currentCall.joined || recoveryPending || !account) return;
  const { toConnect, toRemove } = reconcileMeshPeers(
    account.userId,
    currentCall.participants ?? [],
    [...groupPeers.keys()]
  );
  for (const peerId of toRemove) {
    removeGroupPeer(peerId);
  }
  if (!toConnect.length && !forceRenegotiate) {
    renderCallParticipants();
    return;
  }
  const iceServers = await getIceServers();
  if (!currentCall || !isGroupCall(currentCall)) return;
  for (const item of toConnect) {
    const entry = await ensureGroupPeer(item.userId, { iceServers });
    if (!entry || !currentCall || !isGroupCall(currentCall)) continue;
    if (item.shouldOffer) {
      await sendGroupOffer(entry, { iceRestart: false });
    }
  }
  if (forceRenegotiate) {
    for (const [peerId, entry] of groupPeers.entries()) {
      if (shouldInitiateOffer(account.userId, peerId)) {
        await sendGroupOffer(entry, { iceRestart: true, recoveryMode: "rebuild" });
      } else {
        await sendSignal("resume", { reason: "client-reconnect", mode: "rebuild" }, { targetUserId: peerId }).catch(() => {});
      }
    }
  }
  renderCallParticipants();
  setCallStatus(groupCallStatusText());
}

async function ensureGroupPeer(peerUserId, { iceServers: providedIceServers = null, refreshIce = false } = {}) {
  const existing = groupPeers.get(peerUserId);
  if (existing?.pc && existing.pc.signalingState !== "closed") return existing;
  if (!localStream) localStream = await requestMicrophone();
  const iceServers = providedIceServers ?? await getIceServers({ refresh: refreshIce });
  if (!currentCall || !isGroupCall(currentCall)) return null;

  const pc = createPeerConnectionWithRoutePool(iceServers);
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.playsInline = true;
  audioEl.dataset.peerUserId = peerUserId;
  audioEl.addEventListener("pause", () => {
    if (!currentCall || remoteAudioStopping || !audioEl.srcObject) return;
    void Promise.resolve().then(() => audioEl.play()).catch(() => {});
  });
  elements.callRemoteAudios?.append(audioEl);

  const entry = {
    userId: peerUserId,
    pc,
    audioEl,
    localNegotiationId: null,
    remoteNegotiationId: null,
    remoteCandidates: [],
    offerStarted: false,
    restartInFlight: false,
    disconnectTimer: null,
    recoveryWatchdog: null,
    recoveryAttempt: 0,
    remotePlaybackBlocked: false,
    iceBatcher: null
  };
  entry.iceBatcher = createIceCandidateBatcher({
    flush: (signals) => flushGroupIceBatch(peerUserId, signals),
    windowMs: 40,
    maxBatch: 8,
    immediateFirst: true,
    isUrgent: isRelayCandidateSignal
  });
  groupPeers.set(peerUserId, entry);

  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    if (track.kind === "audio") {
      void tuneAudioSender(sender, undefined, { managedExternally: true }).catch(() => {});
    }
  }

  pc.addEventListener("icecandidate", (event) => {
    if (!currentCall || groupPeers.get(peerUserId)?.pc !== pc) return;
    if (!event.candidate) {
      void entry.iceBatcher.flushNow();
      return;
    }
    const candidate = event.candidate;
    const isInitiator = shouldInitiateOffer(account?.userId, peerUserId);
    entry.iceBatcher.push({
      kind: "ice",
      targetUserId: peerUserId,
      payload: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment ?? null,
        negotiationId: isInitiator ? entry.localNegotiationId : entry.remoteNegotiationId
      }
    });
  });

  pc.addEventListener("icegatheringstatechange", () => {
    if (groupPeers.get(peerUserId)?.pc !== pc) return;
    if (pc.iceGatheringState === "complete") void entry.iceBatcher.flushNow();
  });

  pc.addEventListener("track", (event) => {
    if (groupPeers.get(peerUserId)?.pc !== pc) return;
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    audioEl.srcObject = stream;
    applyJitterBufferTarget(event.receiver, jitterController.targetMs);
    void Promise.resolve().then(() => audioEl.play()).then(() => {
      if (groupPeers.get(peerUserId)?.pc !== pc) return;
      entry.remotePlaybackBlocked = false;
      if (!recoveryPending && !isAnyRemoteAudioBlocked()) elements.callResumeButton.hidden = true;
    }).catch(() => {
      if (groupPeers.get(peerUserId)?.pc !== pc) return;
      entry.remotePlaybackBlocked = true;
      elements.callResumeButton.hidden = false;
      elements.callResumeButton.textContent = "Включить звук";
      setCallStatus("Соединение есть, но Safari заблокировал воспроизведение. Нажмите «Включить звук».");
    });
  });

  pc.addEventListener("connectionstatechange", () => {
    if (groupPeers.get(peerUserId)?.pc !== pc) return;
    renderCallParticipants();
    syncCallPollingCadence();
    if (pc.connectionState === "connected") {
      clearTimeout(entry.disconnectTimer);
      clearTimeout(entry.recoveryWatchdog);
      entry.disconnectTimer = null;
      entry.recoveryWatchdog = null;
      entry.recoveryAttempt = 0;
      setCallStatus(groupCallStatusText());
      return;
    }
    if (pc.connectionState === "disconnected") {
      raiseJitterBufferForNetworkStress(pc, "degraded");
      if (!entry.disconnectTimer) {
        entry.disconnectTimer = setTimeout(() => {
          entry.disconnectTimer = null;
          if (groupPeers.get(peerUserId)?.pc !== pc || !currentCall) return;
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            void recoverGroupPeer(peerUserId, "connection-disconnected", false);
          }
        }, DISCONNECT_RECOVERY_GRACE_MS);
      }
      return;
    }
    if (pc.connectionState === "failed") {
      raiseJitterBufferForNetworkStress(pc, "severe");
      void recoverGroupPeer(peerUserId, "connection-failed", false);
    }
  });

  return entry;
}

async function sendGroupOffer(entry, { iceRestart = false, recoveryMode = null } = {}) {
  if (!currentCall || !isGroupCall(currentCall) || !entry?.pc) return;
  if (entry.restartInFlight) return;
  entry.restartInFlight = true;
  try {
    entry.localNegotiationId = crypto.randomUUID();
    const rawOffer = await entry.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    const offer = await applyLocalDescriptionWithOpusTuning(entry.pc, rawOffer);
    entry.offerStarted = true;
    const payload = {
      type: offer.type,
      sdp: offer.sdp,
      negotiationId: entry.localNegotiationId,
      ...(recoveryMode ? { recoveryMode } : {})
    };
    await sendSignal("offer", payload, { targetUserId: entry.userId });
  } catch (error) {
    logCallEvent("сигнал ошибка", `offer, ${String(error?.name || "network")}`);
  } finally {
    entry.restartInFlight = false;
  }
}

async function flushGroupIceBatch(peerUserId, signals) {
  if (!currentCall || !isGroupCall(currentCall) || !Array.isArray(signals) || !signals.length) return;
  if (signals.length === 1) {
    try {
      await sendSignal("ice", signals[0].payload, { targetUserId: peerUserId });
    } catch {}
    return;
  }
  const sendingCallId = currentCall.callId;
  try {
    const result = await api(callPath("/signals"), {
      method: "POST",
      retries: 1,
      body: JSON.stringify({ signals })
    });
    if (currentCall?.callId !== sendingCallId) return;
    for (const signal of result.signals ?? []) {
      if (signal?.sequence) processedSignalSequences.add(signal.sequence);
    }
  } catch (error) {
    if (currentCall?.callId === sendingCallId) {
      logCallEvent("сигнал ошибка", `ice, ${String(error?.name || "network")}`);
    }
  }
}

async function processGroupSignal(signal) {
  const peerUserId = signal.senderUserId;
  const processingCallId = currentCall?.callId;
  if (!peerUserId || !processingCallId) return true;
  if (signal.kind !== "ice") logCallEvent("сигнал получен", signal.kind);
  try {
    if (signal.kind === "resume") {
      if (shouldInitiateOffer(account?.userId, peerUserId) && !recoveryPending) {
        const hard = signal.payload?.mode === "rebuild";
        await recoverGroupPeer(peerUserId, signal.payload?.reason || "peer-reconnect", hard);
      }
      processedSignalSequences.add(signal.sequence);
      return true;
    }

    let entry = await ensureGroupPeer(peerUserId);
    if (!entry || currentCall?.callId !== processingCallId) return true;

    if (signal.kind === "offer") {
      const incomingNegotiation = signal.payload?.negotiationId ?? null;
      if (incomingNegotiation && incomingNegotiation === entry.remoteNegotiationId &&
          entry.pc.remoteDescription?.sdp === signal.payload.sdp) {
        processedSignalSequences.add(signal.sequence);
        return true;
      }
      if (signal.payload?.recoveryMode === "rebuild" || entry.pc.signalingState !== "stable") {
        const pendingCandidates = entry.remoteCandidates;
        removeGroupPeer(peerUserId);
        entry = await ensureGroupPeer(peerUserId, { refreshIce: signal.payload?.recoveryMode === "rebuild" });
        if (!entry || currentCall?.callId !== processingCallId) return true;
        entry.remoteCandidates = pendingCandidates;
      }
      entry.remoteNegotiationId = incomingNegotiation;
      await entry.pc.setRemoteDescription({ type: signal.payload.type, sdp: signal.payload.sdp });
      await flushGroupRemoteCandidates(entry);
      const rawAnswer = await entry.pc.createAnswer();
      const answer = await applyLocalDescriptionWithOpusTuning(entry.pc, rawAnswer);
      await sendSignal("answer", {
        type: answer.type,
        sdp: answer.sdp,
        negotiationId: entry.remoteNegotiationId
      }, { targetUserId: peerUserId });
      processedSignalSequences.add(signal.sequence);
      return true;
    }

    if (signal.kind === "answer") {
      if (signal.payload?.negotiationId && signal.payload.negotiationId !== entry.localNegotiationId) {
        processedSignalSequences.add(signal.sequence);
        return true;
      }
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: signal.payload.type, sdp: signal.payload.sdp });
        await flushGroupRemoteCandidates(entry);
      }
      processedSignalSequences.add(signal.sequence);
      return true;
    }

    if (signal.kind === "ice") {
      const isInitiator = shouldInitiateOffer(account?.userId, peerUserId);
      const currentGen = isInitiator ? entry.localNegotiationId : entry.remoteNegotiationId;
      const disposition = classifyIceCandidate(signal.payload?.negotiationId, currentGen, !isInitiator);
      if (disposition === "ignore") {
        processedSignalSequences.add(signal.sequence);
        return true;
      }
      if (disposition === "queue" || !entry.pc.remoteDescription) {
        entry.remoteCandidates.push(signal.payload);
        if (entry.remoteCandidates.length > 128) entry.remoteCandidates.splice(0, entry.remoteCandidates.length - 128);
      } else {
        await entry.pc.addIceCandidate(signal.payload);
      }
    }
    processedSignalSequences.add(signal.sequence);
    return true;
  } catch (error) {
    if (currentCall?.callId !== processingCallId) return true;
    logCallEvent("сигнал ошибка", `${signal.kind}, ${String(error?.name || "network")}`);
    return false;
  }
}

async function flushGroupRemoteCandidates(entry) {
  if (!entry?.pc?.remoteDescription) return;
  const queued = entry.remoteCandidates;
  entry.remoteCandidates = [];
  const isInitiator = shouldInitiateOffer(account?.userId, entry.userId);
  const expected = isInitiator ? entry.localNegotiationId : entry.remoteNegotiationId;
  for (const candidate of queued) {
    if (candidate.negotiationId && expected && candidate.negotiationId !== expected) continue;
    try { await entry.pc.addIceCandidate(candidate); } catch {}
  }
}

async function recoverGroupPeer(peerUserId, reason, hard) {
  if (!currentCall || !isGroupCall(currentCall) || recoveryPending) return;
  let entry = groupPeers.get(peerUserId);
  if (!entry) return;
  entry.recoveryAttempt += 1;
  if (shouldInitiateOffer(account?.userId, peerUserId)) {
    const freshIce = await getIceServers({ refresh: true });
    if (hard || entry.pc.signalingState !== "stable") {
      removeGroupPeer(peerUserId);
      entry = await ensureGroupPeer(peerUserId, { iceServers: freshIce });
      if (!entry) return;
    } else {
      try { entry.pc.restartIce?.(); } catch {}
    }
    await sendGroupOffer(entry, { iceRestart: true, recoveryMode: hard ? "rebuild" : "ice-restart" });
  } else {
    await sendSignal("resume", { reason, mode: hard ? "rebuild" : "ice-restart" }, { targetUserId: peerUserId }).catch(() => {});
  }
}

async function recoverAllGroupPeers(reason, hard) {
  for (const peerUserId of [...groupPeers.keys()]) {
    await recoverGroupPeer(peerUserId, reason, hard);
  }
}

function removeGroupPeer(peerUserId) {
  const entry = groupPeers.get(peerUserId);
  if (!entry) return;
  groupPeers.delete(peerUserId);
  clearTimeout(entry.disconnectTimer);
  clearTimeout(entry.recoveryWatchdog);
  entry.iceBatcher?.clear();
  for (const sender of entry.pc?.getSenders?.() ?? []) stopAdaptiveBitrate(sender);
  remoteAudioStopping = true;
  try { entry.audioEl?.pause?.(); } catch {}
  if (entry.audioEl) {
    entry.audioEl.srcObject = null;
    entry.audioEl.remove();
  }
  remoteAudioStopping = false;
  try { entry.pc?.close?.(); } catch {}
}

function cleanupGroupPeers() {
  for (const peerId of [...groupPeers.keys()]) {
    removeGroupPeer(peerId);
  }
}

function showIncoming(call) {
  setCallActivityFlag(true);
  startCallTimer();
  elements.callPanel.hidden = false;
  setCallPresentation("incoming");
  const group = isGroupCall(call);
  elements.callTitle.textContent = group ? "Входящий групповой звонок" : "Входящий звонок";
  elements.callPeer.textContent = group
    ? `${call.groupTitle || call.peer.displayName} · ${call.caller?.displayName ?? ""}`.trim()
    : `${call.peer.displayName}, @${call.peer.username}`;
  setCallStatus(group ? "Приглашение в групповой аудиозвонок." : "Входящий аудиозвонок.");
  elements.callAnswerButton.textContent = group ? "Присоединиться" : "Ответить";
  elements.callAnswerButton.hidden = false;
  elements.callDeclineButton.hidden = false;
  elements.callResumeButton.hidden = true;
  elements.callHandoffButton.hidden = true;
  elements.callMuteButton.hidden = true;
  if (document.querySelector("#call-audio-cycle")) document.querySelector("#call-audio-cycle").hidden = true;
  elements.callEndButton.hidden = true;
  if (elements.callEndAllButton) elements.callEndAllButton.hidden = true;
  renderCallParticipants();
  syncCallButton();
  elements.callAnswerButton.focus();
}

function showOutgoing(call) {
  setCallActivityFlag(true);
  startCallTimer();
  elements.callPanel.hidden = false;
  setCallPresentation("outgoing");
  elements.callTitle.textContent = "Исходящий звонок";
  elements.callPeer.textContent = `${call.peer.displayName}, @${call.peer.username}`;
  setCallStatus(`Ожидаю ответа… Режим: ${getSelectedAudioProfile().label}.`);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callHandoffButton.hidden = true;
  elements.callMuteButton.hidden = false;
  headsetControls?.activate(muted);
  elements.callMuteButton.setAttribute?.("aria-pressed", String(muted));
  if (document.querySelector("#call-audio-cycle")) document.querySelector("#call-audio-cycle").hidden = false;
  elements.callEndButton.textContent = "Завершить звонок";
  elements.callEndButton.hidden = false;
  if (elements.callEndAllButton) elements.callEndAllButton.hidden = true;
  renderCallParticipants();
  syncCallButton();
  elements.callEndButton.focus();
}

function showConnectedControls(status) {
  setCallActivityFlag(true);
  startCallTimer();
  if (currentCall?.status === "accepted" && !audioConnectedOnce && !isGroupCall(currentCall))
    initialConnectionWatchdog.arm(currentCall.callId);
  elements.callPanel.hidden = false;
  const focusMoved = [elements.callAnswerButton, elements.callResumeButton].includes(document.activeElement);
  setCallPresentation("connected");
  const group = isGroupCall(currentCall);
  elements.callTitle.textContent = group ? "Групповой звонок" : "Аудиозвонок";
  if (group) {
    elements.callPeer.textContent = currentCall.groupTitle || currentCall.peer?.displayName || "Группа";
  }
  setCallStatus(status);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = !isAnyRemoteAudioBlocked();
  elements.callHandoffButton.hidden = true;
  elements.callMuteButton.hidden = false;
  headsetControls?.activate(muted);
  elements.callMuteButton.setAttribute?.("aria-pressed", String(muted));
  if (document.querySelector("#call-audio-cycle")) document.querySelector("#call-audio-cycle").hidden = false;
  elements.callEndButton.textContent = group ? "Покинуть звонок" : "Завершить звонок";
  elements.callEndButton.hidden = false;
  renderCallParticipants();
  syncCallButton();
  if (focusMoved) elements.callEndButton.focus();
}

function showRecoveredCall(status) {
  startCallTimer();
  if (!currentCall) return;
  elements.callPanel.hidden = false;
  setCallPresentation("connected");
  const group = isGroupCall(currentCall);
  elements.callTitle.textContent = group ? "Активный групповой звонок" : "Активный звонок";
  elements.callPeer.textContent = group
    ? (currentCall.groupTitle || currentCall.peer.displayName)
    : `${currentCall.peer.displayName}, @${currentCall.peer.username}`;
  setCallStatus(status);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  const moved = currentCall.status === "accepted" &&
    currentCall.sessionOwnerId && currentCall.sessionOwnerId !== getCurrentSession()?.sessionId;
  elements.callResumeButton.hidden = Boolean(moved);
  elements.callHandoffButton.hidden = !moved;
  elements.callMuteButton.hidden = true;
  if (document.querySelector("#call-audio-cycle")) document.querySelector("#call-audio-cycle").hidden = true;
  elements.callEndButton.textContent = group ? "Покинуть звонок" : "Завершить звонок";
  elements.callEndButton.hidden = false;
  renderCallParticipants();
  syncCallButton();
}

function clearCallNotifications(callId) {
  try {
    if (!("serviceWorker" in navigator)) return;
    const message = { type: "bulbam.call-clear", callId: typeof callId === "string" ? callId : "" };
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(message);
      return;
    }
    navigator.serviceWorker.ready?.then((registration) => {
      registration?.active?.postMessage(message);
    }).catch(() => {});
  } catch {}
}

function finishCall(message) {
  if (currentCall) {
    callProfiler.mark("call_ended", activeProfileSessionId);
    logProfilerSummaryOnce(activeProfileSessionId);
    clearCallNotifications(currentCall.callId);
    logCallEvent(message.includes("отклон") ? "звонок отклонён" : "звонок завершён");
    stopCallCues();
    playCallCue(message.includes("отклон") ? "declined" : "ended");
  }
  cleanupMedia();
  currentCall = null;
  answeredLocally = false;
  offerStarted = false;
  recoveryPending = false;
  renderFinished(message);
  renderCallParticipants();
  renderGroupCallBanner();
  syncCallButton();
}

function renderFinished(message) {
  elements.callPanel.hidden = false;
  setCallPresentation("finished");
  elements.callDiagnostics.hidden = false;
  elements.callTitle.textContent = "Звонок";
  elements.callPeer.textContent = "";
  setCallStatus(message);
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callHandoffButton.hidden = true;
  elements.callMuteButton.hidden = true;
  if (document.querySelector("#call-audio-cycle")) document.querySelector("#call-audio-cycle").hidden = true;
  elements.callEndButton.hidden = true;
  if (elements.callEndAllButton) elements.callEndAllButton.hidden = true;
  elements.callDismissButton.focus();
}

function renderIdle() {
  elements.callPanel.hidden = true;
  setCallPresentation("idle");
  elements.callPeer.textContent = "";
  elements.callStatus.textContent = "Звонок не активен.";
  elements.callAnswerButton.hidden = true;
  elements.callDeclineButton.hidden = true;
  elements.callResumeButton.hidden = true;
  elements.callHandoffButton.hidden = true;
  elements.callMuteButton.hidden = true;
  if (document.querySelector("#call-audio-cycle")) document.querySelector("#call-audio-cycle").hidden = true;
  elements.callEndButton.hidden = true;
  if (elements.callEndAllButton) elements.callEndAllButton.hidden = true;
  renderCallParticipants();
}

function setCallPresentation(mode) {
  elements.callDiagnostics.hidden = !(mode === "incoming" || mode === "outgoing" || mode === "connected");
  if (["incoming", "outgoing", "finished", "idle"].includes(mode)) {
    elements.callPanel.classList.remove("is-minimized");
  }
  const canMinimize = mode === "outgoing" || mode === "connected";
  const minimized = elements.callPanel.classList.contains("is-minimized");
  elements.callMinimizeButton.hidden = !canMinimize || minimized;
  elements.callExpandButton.hidden = !canMinimize || !minimized;
  elements.callDismissButton.hidden = mode !== "finished";
  const fullScreen = !elements.callPanel.hidden && !minimized;
  const shell = document.querySelector(".messenger-shell");
  if (shell) shell.inert = fullScreen;
  if (fullScreen) elements.callPanel.setAttribute?.("aria-modal", "true");
  else elements.callPanel.removeAttribute?.("aria-modal");
}

function minimizeCall() {
  if (!currentCall) return;
  elements.callPanel.classList.add("is-minimized");
  setCallPresentation("connected");
  elements.callExpandButton.focus();
}

function expandCall() {
  if (!currentCall) return;
  elements.callPanel.classList.remove("is-minimized");
  setCallPresentation("connected");
  elements.callTitle.focus();
}

function dismissFinishedCall() {
  if (currentCall) return;
  renderIdle();
  const target = document.body.classList.contains("conversation-open")
    ? elements.conversationTitle
    : document.querySelector("#chats-title");
  target?.focus();
}

function startCallTimer() {
  stopCallTimer();
  refreshCallTimer();
  if (currentCall?.status === "accepted") {
    callTimerInterval = setInterval(refreshCallTimer, 1_000);
  }
}

function refreshCallTimer() {
  const active = currentCall?.status === "accepted" &&
    Number.isFinite(Number(currentCall.answeredAt)) && Number(currentCall.answeredAt) > 0;
  elements.callDuration.hidden = !active;
  if (active) elements.callDuration.textContent =
    `Время звонка: ${formatCallDuration(currentCall.answeredAt)}`;
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  elements.callDuration.hidden = true;
}

function setCallRouteAvailability(servers) {
  if (!currentCall) return;
  logCallEvent("ICE конфигурация", turnAvailable(servers) ? "turn и stun" : "только stun");
  elements.callDiagnosticsText.textContent = turnAvailable(servers)
    ? "TURN-сервер доступен в настройках. Реальный маршрут определится после соединения."
    : "TURN-сервер не настроен. Используется попытка прямого соединения.";
}

function updateCallDiagnostics(pc) {
  if (peerConnection !== pc || !currentCall) return;
  elements.callDiagnosticsText.textContent = describeCallDiagnostics(pc, null);
}

function setCallStatus(text) {
  elements.callStatus.textContent = text;
}

function syncCallButton() {
  const chatSelected = Boolean(account) &&
    !elements.messageForm.hidden &&
    Boolean(elements.messageForm.dataset?.conversationId ||
      elements.conversationPeer.textContent.trim().startsWith("@"));
  elements.callStartButton.hidden = !chatSelected || Boolean(currentCall);
}

function toggleMute() { setMuted(!muted); }

function setMuted(nextMuted) {
  if (!localStream || !currentCall) return;
  if (currentCall.status !== "accepted" && currentCall.status !== "ringing") return;
  const next = Boolean(nextMuted);
  if (next === muted) {
    ensureRemoteAudioPlaying();
    return;
  }
  muted = next;
  const tracks = localStream.getAudioTracks();
  const hasLiveTrack = tracks.some((track) => track.readyState !== "ended");
  if (!muted && !hasLiveTrack) {
    void recoverLocalMicrophoneTrack();
  }
  for (const track of tracks) track.enabled = !muted;
  const allPcs = [peerConnection, ...[...groupPeers.values()].map((entry) => entry.pc)].filter(Boolean);
  for (const pc of allPcs) {
    for (const sender of pc.getSenders?.() ?? []) {
      if (sender.track?.kind === "audio") sender.track.enabled = !muted;
    }
  }
  elements.callMuteButton.textContent = muted ? "Включить микрофон" : "Выключить микрофон";
  elements.callMuteButton.setAttribute?.("aria-pressed", String(muted));
  headsetControls?.updateMuted(muted);
  ensureRemoteAudioPlaying();
  announce(muted ? "Микрофон выключен." : "Микрофон включён.");
  if (isGroupCall(currentCall) && currentCall.status === "accepted" && currentCall.joined) {
    if (Array.isArray(currentCall.participants)) {
      currentCall.participants = currentCall.participants.map((entry) =>
        entry.userId === account?.userId ? { ...entry, muted } : entry
      );
      renderCallParticipants();
    }
    void api(callPath("/mute"), {
      method: "POST",
      body: JSON.stringify({ muted })
    }).catch(() => {});
  }
}

function cleanupMedia() {
  setCallActivityFlag(false);
  abortCallRequests();
  initialConnectionWatchdog.disarm();
  watchdogExtended = false;
  recoveryGate.reset();
  networkRestoration.reset();
  pendingFastRecovery = null;
  headsetControls?.deactivate();
  profileSwitchEpoch += 1;
  logCallEvent("очистка звонка");
  stopCallTimer();
  stopRingback();
  clearTimeout(ringTimeout);
  ringTimeout = null;
  stopCallPolling();
  cleanupPeerConnection();
  cleanupGroupPeers();
  stopLocalStream();
  clearNetworkRecoveryState();
  processedSignalSequences = new Set();
  signalPollCursor = 0;
  signalProcessingQueue = Promise.resolve();
  signalPollInFlight = false;
  signalPollRequestId++;
  remoteCandidates = [];
  remotePlaybackBlocked = false;
  elements.callResumeButton.textContent = "Восстановить звук";
  iceBatcher.clear();
  muted = false;
  restartInFlight = false;
  const iceCacheFresh = lastIceServers && (Date.now() - iceServersFetchedAt) < ICE_CACHE_TTL_MS;
  if (!iceCacheFresh) {
    iceRequestEpoch.invalidate();
    iceServersPromise = null;
    lastIceServers = null;
    iceServersFetchedAt = 0;
  }
  elements.callMuteButton.textContent = "Выключить микрофон";
  elements.callMuteButton.setAttribute?.("aria-pressed", "false");
  remoteAudioStopping = true;
  try { elements.callRemoteAudio.pause(); } catch {}
  elements.callRemoteAudio.srcObject = null;
  remoteAudioStopping = false;
}

function cleanupPeerConnection() {
  peerCreationEpoch += 1;
  disposePrewarmedIncoming();
  stopFirstAudioFrameProbe();
  iceBatcher.clear();
  jitterController.reset();
  if (peerConnection) {
    logCallEvent("WebRTC закрыт");
    for (const sender of peerConnection.getSenders?.() ?? []) stopAdaptiveBitrate(sender);
  }
  peerConnectionPromise = null;
  stopQualityMonitoring();
  if (elements.callRemoteAudio) {
    remoteAudioStopping = true;
    try { elements.callRemoteAudio.pause(); } catch {}
    elements.callRemoteAudio.srcObject = null;
    remoteAudioStopping = false;
  }
  remotePlaybackBlocked = false;
  if (peerConnection) {
    try { peerConnection.close(); } catch {}
  }
  peerConnection = null;
  relayCandidateSeen = false;
  remoteCandidates = [];
  localNegotiationId = null;
  remoteNegotiationId = null;
}

function clearNetworkRecoveryState() {
  clearAutomaticRecoveryTimers();
  stopQualityMonitoring();
  recoveryAttempt = 0;
  jitterController.reset();
  audioConnectedOnce = false;
  networkRecoveryActive = false;
  lastConnectedAt = 0;
  watchdogExtended = false;
}

function stopLocalStream() {
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
  }
  localStream = null;
}

function resetCallRuntime() {
  setCallActivityFlag(false);
  abortCallRequests();
  initialConnectionWatchdog.disarm();
  watchdogExtended = false;
  recoveryGate.reset();
  networkRestoration.reset();
  pendingFastRecovery = null;
  headsetControls?.deactivate();
  profileSwitchEpoch += 1;
  clearTimeout(icePrefetchTimer);
  icePrefetchTimer = null;
  iceBatcher.clear();
  stopCallTimer();
  clearTimeout(ringTimeout);
  ringTimeout = null;
  stopCallPolling();
  cleanupPeerConnection();
  cleanupGroupPeers();
  stopLocalStream();
  processedSignalSequences = new Set();
  signalPollCursor = 0;
  signalProcessingQueue = Promise.resolve();
  signalPollInFlight = false;
  signalPollRequestId++;
  remotePlaybackBlocked = false;
  elements.callResumeButton.textContent = "Восстановить звук";
  answeredLocally = false;
  offerStarted = false;
  restartInFlight = false;
  recoveryPending = false;
  muted = false;
  iceRequestEpoch.invalidate();
  iceServersPromise = null;
  lastIceServers = null;
  iceServersFetchedAt = 0;
  clearNetworkRecoveryState();
}

function friendlyMediaError(error) {
  return explainMicrophoneError(error);
}
