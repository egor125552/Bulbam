import { translateText } from "./i18n.js";
import { api, deviceName } from "./api.js";
import { detachPushSubscription } from "./push.js";
import { loadSessions } from "./sessions.js";
import { setupPasskeys, startPasskeyAutofill, cancelPasskeyAutofill } from "./passkeys.js";
import { announce, elements, getCurrentAccount, showSignedIn, showSignedOut, updateAccountProfile } from "./ui.js";

const AUTH_VIEWS = ["login", "register", "recovery"];
const ACCOUNT_HINT_KEY = "bulbam.account.lastUsername";
const USERNAME_GUIDANCE = "Имя пользователя: от 3 до 32 русских, белорусских или латинских букв, цифр и знаков подчёркивания. Например, пользователь1.";
const USERNAME_PATTERN=/^[a-z0-9_\p{Script=Cyrillic}]{3,32}$/u;
function canonicalUsername(raw){
  return String(raw??"").normalize("NFKC").trim().replace(/^@/,"").toLowerCase();
}

function validateRegistrationUsername() {
  const input=elements.registerForm.querySelector('[name="username"]');
  const error=document.querySelector("#register-username-error");
  const username=canonicalUsername(input?.value);
  if(USERNAME_PATTERN.test(username)){
    input?.removeAttribute("aria-invalid");
    if(error){error.hidden=true;error.textContent="";}
    return username;
  }
  if(input)input.setAttribute("aria-invalid","true");
  if(error){error.textContent=translateText(USERNAME_GUIDANCE);error.hidden=false;}
  announce(USERNAME_GUIDANCE);
  input?.focus();
  return null;
}

let visibleRecoveryCodes = [];

function showAuthView(view) {
  if (!AUTH_VIEWS.includes(view)) return;
  if (view !== "login") cancelPasskeyAutofill();
  for (const candidate of AUTH_VIEWS) {
    const panel = document.querySelector(`#auth-view-${candidate}`);
    if (panel) panel.hidden = candidate !== view;
  }
  document.querySelector(`#auth-${view}-heading`)?.focus();
  if (view === "login" && !getCurrentAccount()) void startPasskeyAutofill();
}

function rememberUsername(account) {
  if (!account?.username) return;
  try { localStorage.setItem(ACCOUNT_HINT_KEY, account.username); } catch {}
}

function knownUsername() {
  try {
    const value = localStorage.getItem(ACCOUNT_HINT_KEY) ?? "";
    return USERNAME_PATTERN.test(value) ? value : null;
  } catch { return null; }
}

function restoreUsernameHint() {
  const username = knownUsername();
  if (!username) return;
  const loginInput = elements.loginForm.querySelector('[name="username"]');
  const recoveryInput = document.querySelector('#recovery-form [name="username"]');
  const adminRecoveryInput = document.querySelector('#admin-recovery-form [name="username"]');
  if (loginInput && !loginInput.value) loginInput.value = username;
  if (recoveryInput && !recoveryInput.value) recoveryInput.value = username;
  if (adminRecoveryInput && !adminRecoveryInput.value) adminRecoveryInput.value = username;
}

export function showRecoveryCodes(codes) {
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
  setupPasskeys(async (account, session) => {
    clearAuthCheckProblem();
    showSignedIn(account, session);
    rememberUsername(account);
    announce(`Вы вошли как ${account.displayName} с помощью ключа доступа.`);
    await loadSessions({quiet:true});
  });
  window.addEventListener("bulbam:language-changed",()=>{
    const error=document.querySelector("#register-username-error");
    if(error && !error.hidden)error.textContent=translateText(USERNAME_GUIDANCE);
  });
  elements.registerForm.addEventListener("submit", register);
  setupDisplayNameForms();
  elements.registerForm.querySelector('[name="username"]')?.addEventListener("input",()=>{
    const input=elements.registerForm.querySelector('[name="username"]');
    input.removeAttribute("aria-invalid");
    const error=document.querySelector("#register-username-error");
    if(error){error.hidden=true;error.textContent="";}
  });
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
      if (hint) hint.hidden = !knownUsername();
      if (!quiet) announce(knownUsername()
        ? "Сеанс недействителен или срок его действия истёк. Войдите снова либо восстановите пароль."
        : "Для начала работы войдите в аккаунт или зарегистрируйтесь.");
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

function showOptionalNameSetup(){
  const dialog=document.querySelector("#profile-first-setup-dialog");
  if(!dialog || !getCurrentAccount() || dialog.open)return;
  const blocker=[...document.querySelectorAll("dialog[open]")].find(other=>other!==dialog);
  if(blocker){
    blocker.addEventListener("close",()=>queueMicrotask(showOptionalNameSetup),{once:true});
    return;
  }
  dialog.showModal();
  document.querySelector("#profile-first-setup-title")?.focus();
}

function scheduleOptionalNameSetup(recoveryCodes){
  if(Array.isArray(recoveryCodes) && recoveryCodes.length){
    const dialog=document.querySelector("#recovery-codes-dialog");
    if(dialog){
      dialog.addEventListener("close",()=>queueMicrotask(showOptionalNameSetup),{once:true});
      return;
    }
  }
  queueMicrotask(showOptionalNameSetup);
}

async function saveDisplayName(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector("button[type=submit]");
  const first=form.id==="profile-first-setup-form";
  const status=document.querySelector(first?"#profile-first-setup-status":"#profile-settings-status");
  const name=String(new FormData(form).get("displayName")??"").trim();
  if(!name && first){
    document.querySelector("#profile-first-setup-dialog")?.close();
    return;
  }
  button.disabled=true;
  try{
    const result=await api("/api/v1/auth/profile",{
      method:"PATCH",body:JSON.stringify({displayName:name})
    });
    updateAccountProfile(result.account);
    const settingsInput=document.querySelector("#profile-settings-display-name");
    if(settingsInput)settingsInput.value=result.account.displayName;
    if(status)status.textContent="Отображаемое имя сохранено.";
    announce("Отображаемое имя сохранено.");
    if(first)document.querySelector("#profile-first-setup-dialog")?.close();
  }catch(error){
    if(status)status.textContent="Не удалось сохранить имя: "+error.message;
    announce("Не удалось сохранить имя: "+error.message);
  }finally{button.disabled=false;}
}
function setupDisplayNameForms(){
  for(const id of ["profile-first-setup-form","profile-settings-form"])
    document.querySelector("#"+id)?.addEventListener("submit",saveDisplayName);
  document.querySelector("#profile-first-setup-skip")?.addEventListener("click",()=>{
    document.querySelector("#profile-first-setup-dialog")?.close();
    announce("Вы можете выбрать отображаемое имя позже в настройках.");
  });
  window.addEventListener("bulbam:account-changed",event=>{
    const input=document.querySelector("#profile-settings-display-name");
    if(input)input.value=event.detail?.account?.displayName??"";
  });
}

async function register(event) {
  event.preventDefault();
  const username=validateRegistrationUsername();
  if(username===null)return;
  const button = elements.registerForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(elements.registerForm);
  announce("Создаю аккаунт.");

  try {
    const result = await api("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username,
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
    scheduleOptionalNameSetup(result.recoveryCodes);
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
  cancelPasskeyAutofill();
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
    showRecoveryCodes(result.recoveryCodes);
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
