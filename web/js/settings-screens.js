import { logDiagnostic } from "./diagnostics-log.js";
import { translateText } from "./i18n.js";

const CATEGORIES = [
  { id: "general", title: "Основные", sections: ["appearance-title", "account-title", "presence-settings-title"] },
  { id: "security", title: "Безопасность", sections: ["account-security-title", "passkeys-settings-title", "admin-recovery-queue-title"] },
  { id: "notifications", title: "Уведомления", sections: ["notifications-title"] },
  { id: "voice", title: "Голосовые сообщения", sections: ["voice-settings-title"] },
  { id: "calls", title: "Звонки", sections: [] },
  { id: "devices", title: "Устройства", sections: ["sessions-title", "e2ee-devices-title"] },
  { id: "invites", title: "Приглашения", sections: ["invite-title"] },
  { id: "accessibility", title: "Специальные возможности", sections: ["accessibility-title"] },
  { id: "diagnostics", title: "Диагностика", sections: ["health-title"] },
  { id: "features", title: "Управление функциями", sections: ["feature-controls-title"] }
];

const SUBPAGES = {
  password: { title: "Смена пароля", parent: "security" },
  microphone: { title: "Микрофон и качество звука", parent: "calls" }
};

let dialog;
let chooser;
let screens;
let back;
let heading;
let quickNavigation;
let active = null;
const screenNodes = new Map();
const categoryButtons = new Map();

function translated(value) {
  return translateText(value);
}

export function setupSettingsScreens() {
  dialog = document.querySelector("#settings-dialog");
  const grid = dialog?.querySelector(".settings-grid");
  if (!grid || document.querySelector("#settings-category-list")) return;

  quickNavigation = dialog.querySelector(".settings-section-navigation");
  if (quickNavigation) quickNavigation.hidden = true;

  chooser = document.createElement("nav");
  chooser.id = "settings-category-list";
  chooser.className = "settings-category-list";
  chooser.setAttribute("aria-label", translated("Категории настроек"));

  const categoryHeading = document.createElement("h3");
  categoryHeading.dataset.settingsChooserHeading = "true";
  categoryHeading.textContent = translated("Выберите категорию");
  chooser.append(categoryHeading);

  screens = grid;
  screens.classList.add("settings-screens");
  screens.hidden = true;

  for (const category of CATEGORIES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-category-button";
    button.textContent = translated(category.title);
    button.dataset.openSettings = category.id;
    button.addEventListener("click", () => openSettingsScreen(category.id));
    categoryButtons.set(category.id, button);
    chooser.append(button);

    const screen = document.createElement("section");
    screen.className = "settings-screen";
    screen.dataset.settingsScreen = category.id;
    screen.hidden = true;
    screen.setAttribute("aria-label", translated(category.title));

    for (const titleId of category.sections) {
      const content = document.getElementById(titleId)?.closest(".card");
      if (content) screen.append(content);
    }

    grid.append(screen);
    screenNodes.set(category.id, screen);
  }

  const security = screenNodes.get("security");
  const securityCard = document.getElementById("account-security-title")?.closest(".card");
  const passwordForm = document.querySelector("#change-password-form");
  if (security && securityCard && passwordForm) {
    const action = document.createElement("button");
    action.type = "button";
    action.dataset.settingsSubpage = "password";
    action.textContent = translated("Изменить пароль");
    action.addEventListener("click", () => openSettingsScreen("password"));
    securityCard.insertBefore(action, passwordForm);

    const passwordScreen = document.createElement("section");
    passwordScreen.className = "settings-screen";
    passwordScreen.hidden = true;
    passwordScreen.dataset.settingsScreen = "password";

    const title = document.createElement("h3");
    title.textContent = translated("Смена пароля");
    passwordScreen.append(title, passwordForm);

    const warning = securityCard.querySelector(".hint");
    if (warning) passwordScreen.append(warning);

    grid.append(passwordScreen);
    screenNodes.set("password", passwordScreen);
  }

  const calls = screenNodes.get("calls");
  const microphone = document.getElementById("call-audio-title")?.closest(".card");
  if (calls && microphone) {
    const action = document.createElement("button");
    action.type = "button";
    action.dataset.settingsSubpage = "microphone";
    action.textContent = translated("Микрофон и качество звука");
    action.addEventListener("click", () => openSettingsScreen("microphone"));
    calls.append(action);

    const page = document.createElement("section");
    page.className = "settings-screen";
    page.hidden = true;
    page.dataset.settingsScreen = "microphone";
    page.append(microphone);
    grid.append(page);
    screenNodes.set("microphone", page);
  }

  const diagnostics = dialog.querySelector(".developer-details");
  const diagnosticsContent = diagnostics?.querySelector(".diagnostics-panel");
  if (diagnosticsContent) {
    screenNodes.get("diagnostics")?.append(diagnosticsContent);
    diagnostics.remove();
  }

  dialog.querySelector(".settings-header")?.after(chooser);

  back = document.createElement("button");
  back.id = "settings-back";
  back.type = "button";
  back.textContent = translated("Назад к категориям");
  back.hidden = true;
  back.addEventListener("click", goBackInSettings);
  dialog.querySelector("#settings-title")?.parentElement?.append(back);

  heading = document.querySelector("#settings-title");

  dialog.addEventListener("close", resetSettingsScreen);
  dialog.addEventListener("cancel", (event) => {
    if (!active) return;
    event.preventDefault();
    goBackInSettings();
  });

  document.querySelector("#settings-button")?.addEventListener("click", () => {
    resetSettingsScreen();
    queueMicrotask(showCategoryFocus);
  });

  window.addEventListener("bulbam:account-changed", updateSettingsCategories);
  window.addEventListener("bulbam:language-changed", updateLanguage);

  const invite = document.querySelector("#invite-card");
  if (invite) {
    new MutationObserver(updateSettingsCategories).observe(invite, {
      attributes: true,
      attributeFilter: ["hidden"]
    });
  }

  updateSettingsCategories();
  resetSettingsScreen();
}

function updateSettingsCategories() {
  const invite = document.querySelector("#invite-card");
  const button = categoryButtons.get("invites");
  if (button) button.hidden = !invite || invite.hidden;
  const featureButton=categoryButtons.get('features');
  if(featureButton)featureButton.hidden = document.querySelector('#account-role')?.textContent !== 'owner';
}

function updateLanguage() {
  chooser?.setAttribute("aria-label", translated("Категории настроек"));
  const chooserHeading = chooser?.querySelector("[data-settings-chooser-heading]");
  if (chooserHeading) chooserHeading.textContent = translated("Выберите категорию");

  for (const category of CATEGORIES) {
    const button = categoryButtons.get(category.id);
    if (button) button.textContent = translated(category.title);
    screenNodes.get(category.id)?.setAttribute("aria-label", translated(category.title));
  }

  const passwordButton = document.querySelector('[data-settings-subpage="password"]');
  if (passwordButton) passwordButton.textContent = translated("Изменить пароль");
  const microphoneButton = document.querySelector('[data-settings-subpage="microphone"]');
  if (microphoneButton) microphoneButton.textContent = translated("Микрофон и качество звука");

  if (active) openSettingsScreen(active);
  else resetSettingsScreen();
}

export function openSettingsScreen(id) {
  if (!screenNodes.has(id)) return;
  if (!dialog?.open) dialog?.showModal();

  const category = CATEGORIES.find((item) => item.id === id);
  const parent = SUBPAGES[id]?.parent ?? null;
  active = id;
  logDiagnostic("Навигация", "раздел настроек", id);

  chooser.hidden = true;
  screens.hidden = false;
  for (const [key, node] of screenNodes) node.hidden = key !== id;

  if (back) {
    back.hidden = false;
    back.textContent = parent === "security"
      ? translated("Назад к безопасности")
      : parent === "calls"
        ? translated("Назад к звонкам")
        : translated("Назад к категориям");
  }

  if (heading) {
    heading.textContent = translated(category?.title ?? SUBPAGES[id]?.title ?? "Настройки");
    heading.focus({ preventScroll: true });
  }

  dialog.scrollTop = 0;
}

function goBackInSettings() {
  if (!active) {
    dialog?.close();
    return;
  }

  if (SUBPAGES[active]?.parent) {
    const parent = SUBPAGES[active].parent;
    openSettingsScreen(parent);
    screenNodes.get(parent)?.querySelector("button")?.focus({ preventScroll: true });
    return;
  }

  const previous = active;
  resetSettingsScreen();
  (categoryButtons.get(previous) ?? categoryButtons.get("general"))?.focus({ preventScroll: true });
}

export function resetSettingsScreen() {
  active = null;
  if (chooser) chooser.hidden = false;
  if (screens) screens.hidden = true;
  for (const node of screenNodes.values()) node.hidden = true;
  if (back) back.hidden = true;
  if (heading) heading.textContent = translated("Настройки");
  if (dialog) dialog.scrollTop = 0;
}

function showCategoryFocus() {
  const title = document.querySelector("#settings-category-list h3");
  title?.setAttribute("tabindex", "-1");
  title?.focus({ preventScroll: true });
}
