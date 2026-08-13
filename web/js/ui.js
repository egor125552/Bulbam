export const elements = {
  workerStatus: document.querySelector("#worker-status"),
  storageStatus: document.querySelector("#storage-status"),
  liveStatus: document.querySelector("#live-status"),
  checkButton: document.querySelector("#check-server"),
  signedOut: document.querySelector("#signed-out"),
  signedIn: document.querySelector("#signed-in"),
  registerForm: document.querySelector("#register-form"),
  loginForm: document.querySelector("#login-form"),
  logoutButton: document.querySelector("#logout"),
  pushStatus: document.querySelector("#push-status"),
  pushEnableButton: document.querySelector("#push-enable"),
  pushDisableButton: document.querySelector("#push-disable"),
  audioProfileSelect: document.querySelector("#audio-profile"),
  audioProfileDescription: document.querySelector("#audio-profile-description"),
  audioProfileStatus: document.querySelector("#audio-profile-status"),
  audioProfileTestButton: document.querySelector("#audio-profile-test"),
  sessionsRoot: document.querySelector("#sessions"),
  refreshSessionsButton: document.querySelector("#refresh-sessions"),
  inviteCard: document.querySelector("#invite-card"),
  inviteForm: document.querySelector("#invite-form"),
  newInvite: document.querySelector("#new-invite"),
  newInviteCode: document.querySelector("#new-invite-code"),
  newChatButton: document.querySelector("#new-chat-button"),
  userSearchPanel: document.querySelector("#user-search-panel"),
  userSearchInput: document.querySelector("#user-search-input"),
  userSearchResults: document.querySelector("#user-search-results"),
  chatList: document.querySelector("#chat-list"),
  conversationTitle: document.querySelector("#conversation-title"),
  conversationPeer: document.querySelector("#conversation-peer"),
  conversationEmpty: document.querySelector("#conversation-empty"),
  messageList: document.querySelector("#message-list"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  sendMessageButton: document.querySelector("#send-message"),
  callStartButton: document.querySelector("#call-start"),
  callPanel: document.querySelector("#call-panel"),
  callTitle: document.querySelector("#call-title"),
  callPeer: document.querySelector("#call-peer"),
  callStatus: document.querySelector("#call-status"),
  callAnswerButton: document.querySelector("#call-answer"),
  callDeclineButton: document.querySelector("#call-decline"),
  callResumeButton: document.querySelector("#call-resume"),
  callMuteButton: document.querySelector("#call-mute"),
  callEndButton: document.querySelector("#call-end"),
  callRemoteAudio: document.querySelector("#call-remote-audio")
};

const VOICE_BUFFERING_MESSAGE = "Буферизация голосового сообщения.";
const VOICE_RESUMED_MESSAGE = "Воспроизведение голосового продолжено.";
const BUFFERING_ANNOUNCE_DELAY_MS = 350;
const MESSAGE_VIEW_KEY = "bulbam.ui.messageView";

let currentAccount = null;
let currentSession = null;
let bufferingAnnouncementTimer = null;
let interfaceObserver = null;

export function setupInterface() {
  const settingsButton = document.querySelector("#settings-button");
  const settingsDialog = document.querySelector("#settings-dialog");
  const settingsClose = document.querySelector("#settings-close");
  const messageView = document.querySelector("#message-view");
  const backButton = document.querySelector("#conversation-back");

  const storedView = readMessageView();
  document.documentElement.dataset.messageView = storedView;
  if (messageView) {
    messageView.value = storedView;
    messageView.addEventListener("change", () => {
      const value = messageView.value === "compact" ? "compact" : "bubbles";
      document.documentElement.dataset.messageView = value;
      try { localStorage.setItem(MESSAGE_VIEW_KEY, value); } catch {}
      announce(value === "compact" ? "Включён компактный список сообщений." : "Включён вид сообщений пузырьками.");
    });
  }

  settingsButton?.addEventListener("click", () => {
    settingsDialog?.showModal?.();
    document.querySelector("#settings-title")?.focus();
  });
  settingsClose?.addEventListener("click", () => {
    settingsDialog?.close?.();
    settingsButton?.focus();
  });

  backButton?.addEventListener("click", () => {
    document.body.classList.remove("conversation-open");
    document.querySelector("#chats-title")?.focus();
  });
  window.addEventListener("bulbam:chat-changed", (event) => {
    document.body.classList.toggle("conversation-open", Boolean(event.detail?.chat));
  });

  const syncComposer = () => document.body.classList.toggle("composer-has-text", Boolean(elements.messageInput?.value.trim()));
  elements.messageInput?.addEventListener("input", syncComposer);
  elements.messageForm?.addEventListener("submit", () => queueMicrotask(syncComposer));
  syncComposer();

  const decorate = () => {
    const muted = elements.callMuteButton?.textContent.trim().startsWith("Включить");
    if (elements.callMuteButton) elements.callMuteButton.dataset.icon = muted ? "mic-off" : "mic";
    for (const button of document.querySelectorAll(".voice-actions button")) {
      const text = button.textContent.trim();
      if (button.getAttribute("aria-label")?.includes("Воспроизвести или поставить")) {
        button.classList.add("icon-button");
        button.dataset.icon = text === "Пауза" ? "pause" : "play";
      } else if (text === "Назад на 15 секунд") {
        button.classList.add("icon-button");
        button.dataset.icon = "rewind";
        button.setAttribute("aria-label", text);
      } else if (text === "Вперёд на 15 секунд") {
        button.classList.add("icon-button");
        button.dataset.icon = "forward";
        button.setAttribute("aria-label", text);
      } else if (/скорость$/i.test(text)) {
        button.classList.add("button-with-icon");
        button.dataset.icon = "speed";
      }
    }
  };
  decorate();
  interfaceObserver?.disconnect();
  interfaceObserver = new MutationObserver(decorate);
  interfaceObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
}

export function announce(message) {
  if (message === VOICE_BUFFERING_MESSAGE) {
    clearTimeout(bufferingAnnouncementTimer);
    bufferingAnnouncementTimer = setTimeout(() => {
      bufferingAnnouncementTimer = null;
      elements.liveStatus.textContent = message;
    }, BUFFERING_ANNOUNCE_DELAY_MS);
    return;
  }

  if (message === VOICE_RESUMED_MESSAGE) {
    clearTimeout(bufferingAnnouncementTimer);
    bufferingAnnouncementTimer = null;
    if (elements.liveStatus.textContent === VOICE_BUFFERING_MESSAGE) {
      elements.liveStatus.textContent = "";
    }
    return;
  }

  clearTimeout(bufferingAnnouncementTimer);
  bufferingAnnouncementTimer = null;
  elements.liveStatus.textContent = message;
}

export function getCurrentAccount() {
  return currentAccount;
}

export function getCurrentSession() {
  return currentSession;
}

export function showSignedOut() {
  currentAccount = null;
  currentSession = null;
  elements.signedOut.hidden = false;
  elements.signedIn.hidden = true;
  elements.inviteCard.hidden = true;
  elements.sessionsRoot.replaceChildren();
  document.body.classList.remove("conversation-open");
  window.dispatchEvent(new CustomEvent("bulbam:account-changed", { detail: { account: null } }));
}

export function showSignedIn(account, session) {
  currentAccount = account;
  currentSession = session;
  elements.signedOut.hidden = true;
  elements.signedIn.hidden = false;
  document.querySelector("#account-display-name").textContent = account.displayName;
  document.querySelector("#account-username").textContent = `@${account.username}`;
  document.querySelector("#account-id").textContent = account.userId;
  document.querySelector("#account-role").textContent = account.role;
  elements.inviteCard.hidden = !["owner", "admin"].includes(account.role);
  window.dispatchEvent(new CustomEvent("bulbam:account-changed", { detail: { account } }));
}

function readMessageView() {
  try {
    return localStorage.getItem(MESSAGE_VIEW_KEY) === "compact" ? "compact" : "bubbles";
  } catch {
    return "bubbles";
  }
}
