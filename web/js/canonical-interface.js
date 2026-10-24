import { announce, elements } from "./ui.js";
import { originalText } from "./i18n.js";
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
    announce(value === "compact" ? "Включён компактный список сообщений." : "Включён вид сообщений пузырьками.");
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
    if (!event.detail?.account) {
      filterValue = "";
      const search = document.querySelector("#chat-filter");
      if (search) search.value = "";
    }
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
  const muted = originalText(elements.callMuteButton?.textContent.trim()??"").startsWith("Включить");
  setIcon(elements.callMuteButton, muted ? "mic-off" : "mic");
}

function decorateVoiceButtons() {
  for (const button of document.querySelectorAll(".voice-actions button")) {
    const text = originalText(button.textContent.trim());
    if (originalText(button.getAttribute("aria-label")??"").includes("Воспроизвести или поставить")) {
      button.classList.add("icon-button");
      setIcon(button, text === "Пауза" ? "pause" : "play");
    } else if (text === "Назад на 15 секунд") {
      button.classList.add("icon-button");
      setIcon(button, "rewind");
    } else if (text === "Вперёд на 15 секунд") {
      button.classList.add("icon-button");
      setIcon(button, "forward");
    } else if ((/скорость$/i.test(text) || /хуткасць/i.test(text))) {
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
    avatar.textContent = button.dataset.groupIcon || firstLetter(button.querySelector("strong")?.textContent || "Б");
    button.prepend(avatar);
  }
}

function decorateConversationAvatar() {
  const avatar = document.querySelector(".conversation-avatar");
  const next = elements.conversationTitle?.dataset.avatarIcon || firstLetter(elements.conversationTitle?.textContent || "Б");
  if (avatar && avatar.textContent !== next) avatar.textContent = next;
}

function decorateMessages() {
  for (const item of document.querySelectorAll(".message")) {
    if (item.getAttribute("role") !== "group") item.setAttribute("role", "group");
    const author = item.querySelector(".message-author")?.textContent?.trim() || "Сообщение";
    const meta = item.querySelector(".message-meta")?.textContent?.trim() || "";
    const body = item.querySelector(".voice-message")?.getAttribute("aria-label") || item.querySelector(":scope > p")?.textContent?.trim() || "сообщение";
    const safety = item.classList.contains("message-unprotected") ? "Без шифрования. " : "";
    const label = `${author}: ${safety}${body}. ${meta}`.trim();
    if (item.getAttribute("aria-label") !== label) item.setAttribute("aria-label", label);
  }
}

function prepareSidebar() {
  const input = document.querySelector("#chat-filter");
  const clear = document.querySelector("#chat-filter-clear");
  const start = document.querySelector("#chat-start-empty");
  if (!input || !clear) return;

  input.addEventListener("input", () => {
    filterValue = input.value.trim().toLocaleLowerCase("ru");
    filterChats();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    clearSearch();
  });
  clear.addEventListener("click", clearSearch);
  start?.addEventListener("click", () => elements.newChatButton?.click());

  // A convenience shortcut, but standard VoiceOver arrow navigation remains untouched.
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "k") return;
    if (document.querySelector("#settings-dialog")?.open) return;
    if (document.querySelector("#signed-in")?.hidden) return;
    if (document.body.classList.contains("conversation-open") && matchMedia("(max-width: 48rem)").matches) {
      document.querySelector("#conversation-back")?.click();
    }
    event.preventDefault();
    input.focus();
    input.select();
  });
}

function clearSearch() {
  const input = document.querySelector("#chat-filter");
  if (!input) return;
  input.value = "";
  filterValue = "";
  filterChats();
  input.focus();
}

function filterChats() {
  const buttons = document.querySelectorAll(".chat-item");
  let visible = 0;
  for (const button of buttons) {
    const hidden = Boolean(filterValue) && !button.textContent.toLocaleLowerCase("ru").includes(filterValue);
    if (button.hidden !== hidden) button.hidden = hidden;
    if (!hidden) visible += 1;
  }
  const clear = document.querySelector("#chat-filter-clear");
  const empty = document.querySelector("#chat-filter-empty");
  if (clear) clear.hidden = !filterValue;
  if (empty) empty.hidden = !filterValue || !buttons.length || visible > 0;
}

function prepareViewSelect() {
  const old = document.querySelector("#message-view");
  if (!old) return null;
  const select = old.cloneNode(true);
  select.querySelector('option[value="table"]')?.remove();
  old.replaceWith(select);
  return select;
}

function prepareAppearance(viewSelect) {
  const card = document.querySelector("#appearance-title")?.closest(".card");
  if (!card) return { theme: null, scale: null };
  const hint = card.querySelector(".hint");
  if (hint) {
    hint.id ||= "message-view-hint";
    hint.textContent = "Выберите, как удобнее читать переписку. Оба варианта подходят для VoiceOver.";
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
