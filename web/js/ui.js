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

let currentAccount = null;
let currentSession = null;

export function announce(message) {
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
