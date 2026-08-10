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
  sessionsRoot: document.querySelector("#sessions"),
  refreshSessionsButton: document.querySelector("#refresh-sessions"),
  inviteCard: document.querySelector("#invite-card"),
  inviteForm: document.querySelector("#invite-form"),
  newInvite: document.querySelector("#new-invite"),
  newInviteCode: document.querySelector("#new-invite-code")
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
}
