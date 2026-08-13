import { announce, elements } from "./ui.js";
import { normalizeFontScale, normalizeMessageView, normalizeTheme } from "./interface-preferences.js";

const KEYS = {
  view: "bulbam.ui.messageView",
  theme: "bulbam.ui.theme",
  scale: "bulbam.ui.fontScale"
};

let observer;
let scheduled = false;
let filterValue = "";

export function setupCanonicalInterface() {
  const viewSelect = prepareViewSelect();
  const appearance = prepareAppearance(viewSelect);
  prepareSidebar();

  applyView(read(KEYS.view, normalizeMessageView), viewSelect);
  applyTheme(read(KEYS.theme, normalizeTheme), appearance.theme);
  applyScale(read(KEYS.scale, normalizeFontScale), appearance.scale);

  viewSelect?.addEventListener("change", () => {
    const value = normalizeMessageView(viewSelect.value);
    applyView(value, viewSelect);
    save(KEYS.view, value);
    announce(value === "table" ? "Включён табличный вид сообщений." : value === "compact" ? "Включён компактный список сообщений." : "Включён вид сообщений пузырьками.");
  });

  appearance.theme?.addEventListener("change", () => {
    const value = normalizeTheme(appearance.theme.value);
    applyTheme(value, appearance.theme);
    save(KEYS.theme, value);
  });

  appearance.scale?.addEventListener("change", () => {
    const value = normalizeFontScale(appearance.scale.value);
    applyScale(value, appearance.scale);
    save(KEYS.scale, value);
  });

  window.addEventListener("bulbam:account-changed", (event) => {
    document.body.classList.toggle("signed-in-mode", Boolean(event.detail?.account));
    scheduleDecorate();
  });
  elements.messageInput?.addEventListener("input", syncComposer);
  elements.messageForm?.addEventListener("submit", () => queueMicrotask(syncComposer));

  decorate();
  observer?.disconnect();
  observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed"] });
}

function scheduleDecorate() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    decorate();
  });
}

function decorate() {
  syncComposer();
  decorateChats();
  decorateConversationAvatar();
  decorateVoiceButtons();
  decorateMessages();
  filterChats();
}

function syncComposer() {
  document.body.classList.toggle("composer-has-text", Boolean(elements.messageInput?.value.trim()));
  const button = document.querySelector("#voice-record-button");
  const recording = button?.getAttribute("aria-pressed") === "true";
  document.body.classList.toggle("voice-recording", recording);
  setIcon(button, recording ? "stop" : "mic");
  const muted = elements.callMuteButton?.textContent.trim().startsWith("Включить");
  setIcon(elements.callMuteButton, muted ? "mic-off" : "mic");
}

function decorateVoiceButtons() {
  for (const button of document.querySelectorAll(".voice-actions button")) {
    const text = button.textContent.trim();
    if (button.getAttribute("aria-label")?.includes("Воспроизвести или поставить")) {
      button.classList.add("icon-button");
      setIcon(button, text === "Пауза" ? "pause" : "play");
    } else if (text === "Назад на 15 секунд") {
      button.classList.add("icon-button");
      setIcon(button, "rewind");
    } else if (text === "Вперёд на 15 секунд") {
      button.classList.add("icon-button");
      setIcon(button, "forward");
    } else if (/скорость$/i.test(text)) {
      button.classList.add("button-with-icon");
      setIcon(button, "speed");
    }
  }
}

function decorateChats() {
  for (const button of document.querySelectorAll(".chat-item")) {
    if (button.querySelector(":scope > .chat-avatar")) continue;
    const avatar = document.createElement("span");
    avatar.className = "chat-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = firstLetter(button.querySelector("strong")?.textContent || "Б");
    button.prepend(avatar);
  }
}

function decorateConversationAvatar() {
  const avatar = document.querySelector(".conversation-avatar");
  const next = firstLetter(elements.conversationTitle?.textContent || "Б");
  if (avatar && avatar.textContent !== next) avatar.textContent = next;
}

function decorateMessages() {
  for (const item of document.querySelectorAll(".message")) {
    if (item.getAttribute("role") !== "group") item.setAttribute("role", "group");
    const author = item.querySelector(".message-author")?.textContent?.trim() || "Сообщение";
    const meta = item.querySelector(".message-meta")?.textContent?.trim() || "";
    const body = item.querySelector(".voice-message") ? "голосовое сообщение" : item.querySelector(":scope > p")?.textContent?.trim() || "сообщение";
    const label = `${author}: ${body}. ${meta}`.trim();
    if (item.getAttribute("aria-label") !== label) item.setAttribute("aria-label", label);
  }
}

function prepareSidebar() {
  const sidebar = document.querySelector(".chat-sidebar");
  const heading = document.querySelector(".sidebar-heading");
  const nav = document.querySelector(".chat-navigation");
  if (!sidebar || !heading || !nav) return;
  if (!sidebar.querySelector(".sidebar-brand")) {
    const brand = document.createElement("div");
    brand.className = "sidebar-brand";
    brand.innerHTML = '<span class="sidebar-brand-mark" aria-hidden="true">Б</span><strong>Бульбам</strong>';
    sidebar.insertBefore(brand, heading);
  }
  if (!sidebar.querySelector("#chat-filter")) {
    const wrap = document.createElement("div");
    wrap.className = "chat-filter-wrap";
    wrap.innerHTML = '<label class="visually-hidden" for="chat-filter">Поиск по открытым чатам</label><input id="chat-filter" class="chat-filter" type="search" autocomplete="off" placeholder="Поиск по чатам">';
    const input = wrap.querySelector("input");
    input.addEventListener("input", () => { filterValue = input.value.trim().toLocaleLowerCase("ru"); filterChats(); });
    sidebar.insertBefore(wrap, nav);
  }
}

function filterChats() {
  for (const button of document.querySelectorAll(".chat-item")) {
    const next = Boolean(filterValue) && !button.textContent.toLocaleLowerCase("ru").includes(filterValue);
    if (button.hidden !== next) button.hidden = next;
  }
}

function prepareViewSelect() {
  const old = document.querySelector("#message-view");
  if (!old) return null;
  const select = old.cloneNode(true);
  if (!select.querySelector('option[value="table"]')) select.append(new Option("Таблица", "table"));
  old.replaceWith(select);
  return select;
}

function prepareAppearance(viewSelect) {
  const card = document.querySelector("#appearance-title")?.closest(".card");
  if (!card) return { theme: null, scale: null };
  const hint = card.querySelector(".hint");
  if (hint) {
    hint.id ||= "message-view-hint";
    hint.textContent = "Пузырьки — обычный чат. Компактный список — одна строка на сообщение. Таблица — визуальные колонки; для VoiceOver сообщения остаются списком.";
    viewSelect?.setAttribute("aria-describedby", hint.id);
  }
  let controls = card.querySelector(".appearance-controls");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "appearance-controls";
    controls.innerHTML = '<label>Тема<select id="interface-theme"><option value="system">Как на устройстве</option><option value="dark">Тёмная</option><option value="light">Светлая</option></select></label><label>Размер текста<select id="interface-font-scale"><option value="small">Уменьшенный</option><option value="medium">Обычный</option><option value="large">Увеличенный</option></select></label>';
    card.append(controls);
  }
  return { theme: controls.querySelector("#interface-theme"), scale: controls.querySelector("#interface-font-scale") };
}

function setIcon(element, value) { if (element && element.dataset.icon !== value) element.dataset.icon = value; }
function firstLetter(value) { return Array.from(value.trim())[0]?.toLocaleUpperCase("ru") || "Б"; }
function applyView(value, select) { const v = normalizeMessageView(value); document.documentElement.dataset.messageView = v; if (select) select.value = v; }
function applyScale(value, select) { const v = normalizeFontScale(value); document.documentElement.dataset.fontScale = v; if (select) select.value = v; }
function applyTheme(value, select) { const v = normalizeTheme(value); document.documentElement.dataset.theme = v; if (select) select.value = v; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", v === "dark" ? "#0b0e14" : "#f7f7fb"); }
function read(key, normalize) { try { return normalize(localStorage.getItem(key)); } catch { return normalize(null); } }
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }
