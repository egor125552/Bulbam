import { api, deviceName } from "./api.js";
import { detachPushSubscription } from "./push.js";
import { loadSessions } from "./sessions.js";
import { announce, elements, getCurrentAccount, showSignedIn, showSignedOut } from "./ui.js";

const AUTH_VIEWS = ["login", "register", "recovery"];
const ACCOUNT_HINT_KEY = "bulbam.account.lastUsername";
let visibleRecoveryCodes = [];

function showAuthView(view) {
  if (!AUTH_VIEWS.includes(view)) return;
  for (const candidate of AUTH_VIEWS) {
    const panel = document.querySelector(`#auth-view-${candidate}`);
    if (panel) panel.hidden = candidate !== view;
  }
  document.querySelector(`#auth-${view}-heading`)?.focus();
}

function rememberUsername(account) {
  if (!account?.username) return;
  try { localStorage.setItem(ACCOUNT_HINT_KEY, account.username); } catch {}
}

function restoreUsernameHint() {
  let username = "";
  try { username = localStorage.getItem(ACCOUNT_HINT_KEY) ?? ""; } catch {}
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return;
  const loginInput = elements.loginForm.querySelector('[name="username"]');
  const recoveryInput = document.querySelector('#recovery-form [name="username"]');
  if (loginInput && !loginInput.value) loginInput.value = username;
  if (recoveryInput && !recoveryInput.value) recoveryInput.value = username;
}

function showRecoveryCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) {
    announce("Не удалось получить резервные коды. Создайте их в настройках безопасности.");
    return;
  }
  visibleRecoveryCodes = [...codes];
  const dialog = document.querySelector("#recovery-codes-dialog");
  const area = document.querySelector("#recovery-codes-text");
  if (!dialog || !area) return;
  area.value = codes.join("\n");
  dialog.showModal();
  document.querySelector("#recovery-codes-title")?.focus();
  announce("Восемь резервных кодов созданы. Сохраните их. Повторно посмотреть их нельзя.");
}

export function setupAuth() {
  elements.registerForm.addEventListener("submit", register);
  elements.loginForm.addEventListener("submit", login);
  elements.logoutButton.addEventListener("click", logout);
  document.querySelector("#auth-retry")?.addEventListener("click", () => void loadCurrentAccount());
  document.querySelector("#auth-register-button")?.addEventListener("click", () => showAuthView("register"));
  document.querySelector("#auth-forgot-button")?.addEventListener("click", () => {
    restoreUsernameHint();
    showAuthView("recovery");
  });
  document.querySelector("#auth-login-from-register")?.addEventListener("click", () => showAuthView("login"));
  document.querySelector("#auth-login-from-recovery")?.addEventListener("click", () => showAuthView("login"));
  document.querySelector("#recovery-form")?.addEventListener("submit", recoverWithCode);
  document.querySelector("#change-password-form")?.addEventListener("submit", changePassword);
  document.querySelector("#new-recovery-codes")?.addEventListener("click", () => void regenerateRecoveryCodes());
  document.querySelector("#copy-recovery-codes")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(visibleRecoveryCodes.join("\n"));
      announce("Резервные коды скопированы. Сохраните их в безопасном месте.");
    } catch {
      document.querySelector("#recovery-codes-text")?.select();
      announce("Выделены резервные коды. Скопируйте их стандартной командой.");
    }
  });
  document.querySelector("#close-recovery-codes")?.addEventListener("click", () => {
    document.querySelector("#recovery-codes-dialog")?.close();
  });
  document.querySelector("#recovery-codes-dialog")?.addEventListener("close", () => {
    visibleRecoveryCodes = [];
    const field = document.querySelector("#recovery-codes-text");
    if (field) field.value = "";
  });
  restoreUsernameHint();
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
    rememberUsername(result.account);
    if (!quiet) announce(`Вы вошли как ${result.account.displayName}.`);
    await loadSessions({ quiet: true });
  } catch (error) {
    if (error.status === 401) {
      clearAuthCheckProblem();
      showSignedOut();
      restoreUsernameHint();
      showAuthView("login");
      const hint = document.querySelector("#auth-session-note");
      if (hint) hint.hidden = false;
      if (!quiet) announce("Сеанс недействителен или срок его действия истёк. Войдите снова либо восстановите пароль.");
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
    rememberUsername(result.account);
    announce(`Аккаунт ${result.account.displayName} создан. Вы уже вошли в Бульбам.`);
    showRecoveryCodes(result.recoveryCodes);
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
    rememberUsername(result.account);
    const hint = document.querySelector("#auth-session-note");
    if (hint) hint.hidden = true;
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
    showAuthView("login");
    announce("Вы вышли из аккаунта.");
  } catch (error) {
    announce(`Не удалось выйти: ${error.message}`);
  } finally {
    elements.logoutButton.disabled = false;
  }
}

function passwordsMatch(formData) {
  const password = String(formData.get("newPassword") ?? "");
  if (password !== formData.get("confirmPassword")) {
    throw new Error("Пароли не совпадают. Введите одинаковые значения.");
  }
  if (password.length < 10 || password.length > 128) {
    throw new Error("Пароль должен содержать от 10 до 128 символов.");
  }
  return password;
}

async function recoverWithCode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = new FormData(form);
    const newPassword = passwordsMatch(data);
    const result = await api("/api/v1/auth/reset-with-recovery-code", {
      method: "POST",
      body: JSON.stringify({
        username: data.get("username"), code: String(data.get("code") ?? "").trim(),
        newPassword, deviceName: deviceName()
      })
    });
    form.reset();
    clearAuthCheckProblem();
    showSignedIn(result.account, result.session);
    rememberUsername(result.account);
    announce("Пароль восстановлен. Вы вошли в прежний аккаунт. Старые устройства отключены.");
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Не удалось восстановить аккаунт: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const newPassword = passwordsMatch(new FormData(form));
    await api("/api/v1/auth/change-password", {
      method: "POST", body: JSON.stringify({ newPassword })
    });
    form.reset();
    announce("Пароль изменён. Другие устройства отключены, прежние резервные коды недействительны. Создайте новые коды.");
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Не удалось изменить пароль: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function regenerateRecoveryCodes() {
  const button = document.querySelector("#new-recovery-codes");
  if (!button) return;
  if (!confirm("Создать новые коды? Все ранее созданные коды восстановления перестанут работать.")) return;
  button.disabled = true;
  try {
    const result = await api("/api/v1/auth/recovery-codes", { method: "POST" });
    showRecoveryCodes(result.recoveryCodes);
  } catch (error) {
    announce(`Не удалось создать резервные коды: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}
