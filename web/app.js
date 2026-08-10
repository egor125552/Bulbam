const workerStatus = document.querySelector("#worker-status");
const storageStatus = document.querySelector("#storage-status");
const liveStatus = document.querySelector("#live-status");
const checkButton = document.querySelector("#check-server");
const signedOut = document.querySelector("#signed-out");
const signedIn = document.querySelector("#signed-in");
const registerForm = document.querySelector("#register-form");
const loginForm = document.querySelector("#login-form");
const logoutButton = document.querySelector("#logout");
const sessionsRoot = document.querySelector("#sessions");
const refreshSessionsButton = document.querySelector("#refresh-sessions");
const inviteCard = document.querySelector("#invite-card");
const inviteForm = document.querySelector("#invite-form");
const newInvite = document.querySelector("#new-invite");
const newInviteCode = document.querySelector("#new-invite-code");

let currentAccount = null;
let currentSession = null;

function announce(message) {
  liveStatus.textContent = message;
}

function deviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "браузер";
  return `Web · ${platform}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Ошибка HTTP ${response.status}`);
    error.code = payload?.error?.code || "request_failed";
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function checkServer() {
  checkButton.disabled = true;
  workerStatus.textContent = "проверяется…";
  storageStatus.textContent = "проверяется…";
  announce("Проверяю Worker и постоянное хранилище.");

  try {
    const health = await api("/api/health");
    workerStatus.textContent = health.ok ? `работает · ${health.version}` : "ошибка";
  } catch (error) {
    workerStatus.textContent = "нет связи";
    storageStatus.textContent = "не проверено";
    announce(`Worker недоступен: ${error.message}`);
    checkButton.disabled = false;
    return;
  }

  try {
    await api("/api/ready");
    storageStatus.textContent = "готово";
    announce("Worker и постоянное хранилище работают.");
  } catch (error) {
    storageStatus.textContent = "ошибка";
    announce(`Worker работает, но хранилище не готово: ${error.message}`);
  } finally {
    checkButton.disabled = false;
  }
}

function showSignedOut() {
  currentAccount = null;
  currentSession = null;
  signedOut.hidden = false;
  signedIn.hidden = true;
  inviteCard.hidden = true;
  sessionsRoot.replaceChildren();
}

function showSignedIn(account, session) {
  currentAccount = account;
  currentSession = session;
  signedOut.hidden = true;
  signedIn.hidden = false;
  document.querySelector("#account-display-name").textContent = account.displayName;
  document.querySelector("#account-username").textContent = `@${account.username}`;
  document.querySelector("#account-id").textContent = account.userId;
  document.querySelector("#account-role").textContent = account.role;
  inviteCard.hidden = !["owner", "admin"].includes(account.role);
}

async function loadCurrentAccount({ quiet = false } = {}) {
  try {
    const result = await api("/api/v1/auth/me");
    showSignedIn(result.account, result.session);
    if (!quiet) announce(`Вы вошли как ${result.account.displayName}.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    if (error.status === 401) {
      showSignedOut();
      if (!quiet) announce("Вы пока не вошли в аккаунт.");
      return;
    }
    showSignedOut();
    announce(`Не удалось проверить аккаунт: ${error.message}`);
  }
}

async function loadSessions({ quiet = false } = {}) {
  if (!currentAccount) return;
  refreshSessionsButton.disabled = true;
  try {
    const result = await api("/api/v1/sessions");
    renderSessions(result.sessions || []);
    if (!quiet) announce(`Активных сессий: ${result.sessions?.length || 0}.`);
  } catch (error) {
    announce(`Не удалось получить список сессий: ${error.message}`);
  } finally {
    refreshSessionsButton.disabled = false;
  }
}

function renderSessions(sessions) {
  sessionsRoot.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.textContent = "Активных сессий нет.";
    sessionsRoot.append(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "session-list";
  for (const session of sessions) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = session.isCurrent ? `${session.deviceName} · текущая` : session.deviceName;

    const details = document.createElement("span");
    details.textContent = `Последняя активность: ${new Date(session.lastSeenAt).toLocaleString()}`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = session.isCurrent ? "Завершить текущую сессию" : "Завершить сессию";
    button.addEventListener("click", () => revokeSession(session.sessionId, session.isCurrent, button));

    item.append(title, details, button);
    list.append(item);
  }
  sessionsRoot.append(list);
}

async function revokeSession(sessionId, isCurrent, button) {
  button.disabled = true;
  try {
    await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (isCurrent) {
      showSignedOut();
      announce("Текущая сессия завершена.");
      return;
    }
    announce("Сессия устройства завершена.");
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Не удалось завершить сессию: ${error.message}`);
    button.disabled = false;
  }
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = registerForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(registerForm);
  announce("Создаю аккаунт.");
  try {
    const result = await api("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: data.get("username"),
        displayName: data.get("displayName"),
        password: data.get("password"),
        inviteCode: data.get("inviteCode"),
        deviceName: deviceName()
      })
    });
    registerForm.reset();
    showSignedIn(result.account, result.session);
    announce(`Аккаунт ${result.account.displayName} создан. Сессия активна.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Регистрация не удалась: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(loginForm);
  announce("Вхожу в аккаунт.");
  try {
    const result = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: data.get("username"),
        password: data.get("password"),
        deviceName: deviceName()
      })
    });
    loginForm.reset();
    showSignedIn(result.account, result.session);
    announce(`Вы вошли как ${result.account.displayName}.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Войти не удалось: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await api("/api/v1/auth/logout", { method: "POST" });
    showSignedOut();
    announce("Вы вышли из аккаунта.");
  } catch (error) {
    announce(`Не удалось выйти: ${error.message}`);
  } finally {
    logoutButton.disabled = false;
  }
});

refreshSessionsButton.addEventListener("click", () => loadSessions());

inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = inviteForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(inviteForm);
  const expiresInHours = Number(data.get("expiresInHours"));
  newInvite.hidden = true;
  announce("Создаю одноразовое приглашение.");
  try {
    const result = await api("/api/v1/invites", {
      method: "POST",
      body: JSON.stringify({ expiresInHours })
    });
    newInviteCode.textContent = result.code;
    newInvite.hidden = false;
    newInviteCode.focus?.();
    announce("Приглашение создано. Скопируй код: сервер хранит только его хэш.");
  } catch (error) {
    announce(`Не удалось создать приглашение: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

checkButton.addEventListener("click", checkServer);

await checkServer();
await loadCurrentAccount({ quiet: false });
