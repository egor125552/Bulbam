import { api, deviceName } from "./api.js";
import { loadSessions } from "./sessions.js";
import { announce, elements, showSignedIn, showSignedOut } from "./ui.js";

export function setupAuth() {
  elements.registerForm.addEventListener("submit", register);
  elements.loginForm.addEventListener("submit", login);
  elements.logoutButton.addEventListener("click", logout);
}

export async function loadCurrentAccount({ quiet = false } = {}) {
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
    await api("/api/v1/auth/logout", { method: "POST" });
    showSignedOut();
    announce("Вы вышли из аккаунта.");
  } catch (error) {
    announce(`Не удалось выйти: ${error.message}`);
  } finally {
    elements.logoutButton.disabled = false;
  }
}
