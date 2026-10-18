import { api, deviceName } from "./api.js";
import { detachPushSubscription } from "./push.js";
import { loadSessions } from "./sessions.js";
import { announce, elements, getCurrentAccount, showSignedIn, showSignedOut } from "./ui.js";

export function setupAuth() {
  elements.registerForm.addEventListener("submit", register);
  elements.loginForm.addEventListener("submit", login);
  elements.logoutButton.addEventListener("click", logout);
  document.querySelector("#auth-retry")?.addEventListener("click", () => void loadCurrentAccount());
}

function showAuthCheckProblem() {
  const container = document.querySelector("#auth-connection-problem");
  if (container) container.hidden = false;
}

function clearAuthCheckProblem() {
  const container = document.querySelector("#auth-connection-problem");
  if (container) container.hidden = true;
}

export async function loadCurrentAccount({ quiet = false } = {}) {
  const retry = document.querySelector("#auth-retry");
  if (retry) retry.disabled = true;
  try {
    const result = await api("/api/v1/auth/me");
    clearAuthCheckProblem();
    showSignedIn(result.account, result.session);
    if (!quiet) announce(`Вы вошли как ${result.account.displayName}.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    if (error.status === 401) {
      clearAuthCheckProblem();
      showSignedOut();
      if (!quiet) announce("Вход на этом устройстве не действует. Если аккаунт был, войдите с прежним именем пользователя и паролем.");
      return;
    }
    // Network errors and 5xx responses are not proof that the user's session
    // expired. Keep any already authenticated interface rather than wiping it.
    if (!getCurrentAccount()) showSignedOut();
    showAuthCheckProblem();
    announce(`Не удалось проверить вход: ${error.message}. Попробуйте проверить вход ещё раз. Аккаунт не удалён.`);
  } finally {
    if (retry) retry.disabled = false;
  }
}

async function register(event) {
  event.preventDefault();
  const button = elements.registerForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(elements.registerForm);
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
    elements.registerForm.reset();
    clearAuthCheckProblem();
    showSignedIn(result.account, result.session);
    announce(`Аккаунт ${result.account.displayName} создан. Сессия активна.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Регистрация не удалась: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function login(event) {
  event.preventDefault();
  const button = elements.loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(elements.loginForm);
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
    elements.loginForm.reset();
    clearAuthCheckProblem();
    showSignedIn(result.account, result.session);
    announce(`Вы вошли как ${result.account.displayName}.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Войти не удалось: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  elements.logoutButton.disabled = true;
  try {
    await detachPushSubscription();
    await api("/api/v1/auth/logout", { method: "POST" });
    showSignedOut();
    announce("Вы вышли из аккаунта.");
  } catch (error) {
    announce(`Не удалось выйти: ${error.message}`);
  } finally {
    elements.logoutButton.disabled = false;
  }
}
