import { announce, elements } from "./ui.js";
import {
  normalizeFontScale,
  normalizeMessageView,
  normalizeTheme
} from "./interface-preferences.js";

const MESSAGE_VIEW_KEY = "bulbam.ui.messageView";
const THEME_KEY = "bulbam.ui.theme";
const FONT_SCALE_KEY = "bulbam.ui.fontScale";

let observer = null;
let chatFilterValue = "";

export function setupCanonicalInterface() {
  ensureStylesheet();
  const messageView = replaceMessageViewSelect();
  const appearance = enhanceAppearanceSettings(messageView);
  enhanceSidebar();

  applyMessageView(readPreference(MESSAGE_VIEW_KEY, normalizeMessageView), messageView);
  applyTheme(readPreference(THEME_KEY, normalizeTheme), appearance.themeSelect);
  applyFontScale(readPreference(FONT_SCALE_KEY, normalizeFontScale), appearance.fontScaleSelect);

  messageView?.addEventListener("change", () => {
    const value = normalizeMessageView(messageView.value);
    applyMessageView(value, messageView);
    savePreference(MESSAGE_VIEW_KEY, value);
    const text = value === "compact"
      ? "Включён компактный список сообщений."
      : value === "table"
        ? "Включён табличный вид сообщений. Для экранного диктора сообщения остаются списком."
        : "Включён вид сообщений пузырьками.";
    announce(text);
  });

  appearance.themeSelect?.addEventListener("change", () => {
    const value = normalizeTheme(appearance.themeSelect.value);
    applyTheme(value, appearance.themeSelect);
    savePreference(THEME_KEY, value);
    announce(value === "system"
      ? "Тема следует настройке устройства."
      : value === "dark"
        ? "Включена тёмная тема."
        : "Включена светлая тема.");
  });

  appearance.fontScaleSelect?.addEventListener("change", () => {
    const value = normalizeFontScale(appearance.fontScaleSelect.value);
    applyFontScale(value, appearance.fontScaleSelect);
    savePreference(FONT_SCALE_KEY, value);
    announce(value === "small"
      ? "Выбран уменьшенный размер текста."
      : value === "large"
        ? "Выбран увеличенный размер текста."
        : "Выбран обычный размер текста.");
  });

  window.addEventListener("bulbam:account-changed", (event) => {
    document.body.classList.toggle("signed-in-mode", Boolean(event.detail?.account));
  });

  const colorPreference = window.matchMedia?.("(prefers-color-scheme: dark)");
  colorPreference?.addEventListener?.("change", () => {
    if (normalizeTheme(readStorage(THEME_KEY)) === "system") updateThemeColor("system");
  });

  const decorate = () => {
    syncComposerState();
    decorateCallButtons();
    decorateVoicePlayers();
    decorateChats();
    decorateConversationAvatar();
    decorateMessages();
    filterChats(chatFilterValue);
  };

  elements.messageInput?.addEventListener("input", syncComposerState);
  elements.messageForm?.addEventListener("submit", () => queueMicrotask(syncComposerState));

  decorate();
  observer?.disconnect();
  observer = new MutationObserver(decorate);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "hidden"]
  });
}

function ensureStylesheet() {
  if (document.querySelector('link[data-bulbam-canonical-ui]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/canonical-ui.css";
  link.dataset.bulbamCanonicalUi = "true";
  document.head.append(link);
}

function replaceMessageViewSelect() {
  const oldSelect = document.querySelector("#message-view");
  if (!oldSelect) return null;
  const select = oldSelect.cloneNode(true);
  if (!select.querySelector('option[value="table"]')) {
    const option = document.createElement("option");
    option.value = "table";
    option.textContent = "Таблица";
    select.append(option);
  }
  oldSelect.replaceWith(select);
  return select;
}

function enhanceAppearanceSettings(messageView) {
  const card = document.querySelector("#appearance-title")?.closest(".card");
  if (!card) return { themeSelect: null, fontScaleSelect: null };

  const hint = card.querySelector(".hint");
  if (hint) {
    hint.textContent = "Пузырьки — обычный чат. Компактный список — по принципу Telegram-клиента. Таблица добавляет устойчивые визуальные колонки, но для VoiceOver сохраняется семантика списка сообщений.";
  }

  if (messageView) messageView.setAttribute("aria-describedby", hint?.id || "");

  let controls = card.querySelector(".appearance-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "appearance-controls";

    const themeLabel = document.createElement("label");
    themeLabel.htmlFor = "interface-theme";
    themeLabel.append("Тема");
    const themeSelect = document.createElement("select");
    themeSelect.id = "interface-theme";
    themeSelect.innerHTML = '<option value="system">Как на устройстве</option><option value="dark">Тёмная</option><option value="light">Светлая</option>';
    themeLabel.append(themeSelect);

    const scaleLabel = document.createElement("label");
    scaleLabel.htmlFor = "interface-font-scale";
    scaleLabel.append("Размер текста");
    const scaleSelect = document.createElement("select");
    scaleSelect.id = "interface-font-scale";
    scaleSelect.innerHTML = '<option value="small">Уменьшенный</option><option value="medium">Обычный</option><option value="large">Увеличенный</option>';
    scaleLabel.append(scaleSelect);

    controls.append(themeLabel, scaleLabel);
    card.append(controls);
  }

  return {
    themeSelect: controls.querySelector("#interface-theme"),
    fontScaleSelect: controls.querySelector("#interface-font-scale")
  };
}

function enhanceSidebar() {
  const sidebar = document.querySelector(".chat-sidebar");
  const heading = document.querySelector(".sidebar-heading");
  const navigation = document.querySelector(".chat-navigation");
  if (!sidebar || !heading || !navigation) return;

  if (!sidebar.querySelector(".sidebar-brand")) {
    const brand = document.createElement("div");
    brand.className = "sidebar-brand";
    const mark = document.createElement("span");
    mark.className = "sidebar-brand-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "Б";
    const name = document.createElement("strong");
    name.textContent = "Бульбам";
    brand.append(mark, name);
    sidebar.insertBefore(brand, heading);
  }

  if (!sidebar.querySelector("#chat-filter")) {
    const wrap = document.createElement("div");
    wrap.className = "chat-filter-wrap";
    const label = document.createElement("label");
    label.className = "visually-hidden";
    label.htmlFor = "chat-filter";
    label.textContent = "Поиск по открытым чатам";
    const input = document.createElement("input");
    input.id = "chat-filter";
    input.className = "chat-filter";
    input.type = "search";
    input.autocomplete = "off";
    input.placeholder = "Поиск по чатам";
    input.addEventListener("input", () => {
      chatFilterValue = input.value.trim().toLocaleLowerCase("ru");
      filterChats(chatFilterValue);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && input.value) {
        input.value = "";
        chatFilterValue = "";
        filterChats("");
        announce("Фильтр чатов очищен.");
      }
    });
    wrap.append(label, input);
    sidebar.insertBefore(wrap, navigation);
  }
}

function syncComposerState() {
  document.body.classList.toggle("composer-has-text", Boolean(elements.messageInput?.value.trim()));
  const button = document.querySelector("#voice-record-button");
  const recording = button?.getAttribute("aria-pressed") === "true";
  document.body.classList.toggle("voice-recording", recording);
  if (button) button.dataset.icon = recording ? "stop" : "mic";
}

function decorateCallButtons() {
  const muted = elements.callMuteButton?.textContent.trim().startsWith("Включить");
  if (elements.callMuteButton) elements.callMuteButton.dataset.icon = muted ? "mic-off" : "mic";
}

function decorateVoicePlayers() {
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
}

function decorateChats() {
  for (const button of document.querySelectorAll(".chat-item")) {
    if (button.querySelector(":scope > .chat-avatar")) continue;
    const name = button.querySelector(":scope > strong")?.textContent?.trim() || "Б";
    const avatar = document.createElement("span");
    avatar.className = "chat-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = firstLetter(name);
    button.prepend(avatar);
  }
}

function decorateConversationAvatar() {
  const avatar = document.querySelector(".conversation-avatar");
  if (avatar) avatar.textContent = firstLetter(elements.conversationTitle?.textContent || "Б");
}

function decorateMessages() {
  for (const item of document.querySelectorAll(".message")) {
    item.setAttribute("role", "group");
    const author = item.querySelector(".message-author")?.textContent?.trim() || "Сообщение";
    const meta = item.querySelector(".message-meta")?.textContent?.trim() || "";
    const voice = item.querySelector(".voice-message");
    const text = item.querySelector(":scope > p")?.textContent?.trim();
    const description = voice ? "голосовое сообщение" : text || "сообщение";
    item.setAttribute("aria-label", `${author}: ${description}. ${meta}`.trim());
  }
}

function filterChats(query) {
  for (const button of document.querySelectorAll(".chat-item")) {
    button.hidden = Boolean(query) && !button.textContent.toLocaleLowerCase("ru").includes(query);
  }
}

function applyMessageView(value, select) {
  const normalized = normalizeMessageView(value);
  document.documentElement.dataset.messageView = normalized;
  if (select) select.value = normalized;
}

function applyTheme(value, select) {
  const normalized = normalizeTheme(value);
  document.documentElement.dataset.theme = normalized;
  if (select) select.value = normalized;
  updateThemeColor(normalized);
}

function applyFontScale(value, select) {
  const normalized = normalizeFontScale(value);
  document.documentElement.dataset.fontScale = normalized;
  if (select) select.value = normalized;
}

function updateThemeColor(theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0e14" : "#f7f7fb");
}

function firstLetter(value) {
  return Array.from(value.trim())[0]?.toLocaleUpperCase("ru") || "Б";
}

function readPreference(key, normalize) {
  return normalize(readStorage(key));
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
