import { language, translateText } from "./i18n.js";
import { openSettingsScreen } from "./settings-screens.js";
import { announce } from "./ui.js";
import {
  DEFAULT_MESSAGE_READING_MODE,
  MESSAGE_READING_SAMPLE_ITEMS,
  MESSAGE_READING_STORAGE_KEY,
  buildMessageReadingText,
  deliveryStatusSummary,
  formatDurationSpoken,
  formatShortClock,
  normalizeMessageReadingMode,
  readingModeAnnouncement,
  readingModeDescription
} from "./message-reading-core.js";

let currentMode = DEFAULT_MESSAGE_READING_MODE;

export function getMessageReadingMode() {
  return currentMode;
}

export function setMessageReadingMode(nextMode, { silent = false } = {}) {
  const normalized = normalizeMessageReadingMode(nextMode);
  currentMode = normalized;
  document.documentElement.dataset.messageReadingMode = normalized;
  try {
    localStorage.setItem(MESSAGE_READING_STORAGE_KEY, normalized);
  } catch {
    // Private browsing or storage quotas must never break reading preferences.
  }

  const select = document.querySelector("#message-reading-mode");
  if (select && select.value !== normalized) select.value = normalized;

  renderReadingModePreview();
  window.dispatchEvent(new CustomEvent("bulbam:reading-mode-changed", { detail: { mode: normalized } }));

  if (!silent) {
    announce(readingModeAnnouncement(normalized));
  }
  return normalized;
}

export function setupMessageReadingSettings() {
  currentMode = readStoredReadingMode();
  document.documentElement.dataset.messageReadingMode = currentMode;

  const select = document.querySelector("#message-reading-mode");
  if (select) {
    select.value = currentMode;
    select.addEventListener("change", () => {
      setMessageReadingMode(select.value);
    });
  }

  const jumpButton = document.querySelector("#open-accessibility-reading");
  jumpButton?.addEventListener("click", () => {
    openSettingsScreen("accessibility");
    queueMicrotask(() => {
      document.querySelector("#message-reading-mode")?.focus();
    });
  });

  window.addEventListener("bulbam:language-changed", () => {
    renderReadingModePreview();
  });

  renderReadingModePreview();
}

function readStoredReadingMode() {
  try {
    return normalizeMessageReadingMode(localStorage.getItem(MESSAGE_READING_STORAGE_KEY));
  } catch {
    return DEFAULT_MESSAGE_READING_MODE;
  }
}

function renderReadingModePreview() {
  const description = document.querySelector("#message-reading-mode-description");
  const container = document.querySelector("#message-reading-preview");
  if (description) {
    description.textContent = translateText(readingModeDescription(currentMode));
  }
  if (!container) return;

  const locale = language();
  container.replaceChildren();

  const heading = document.createElement("h4");
  heading.className = "reading-preview-heading";
  heading.textContent = translateText("Живой пример — пролистните ниже, чтобы услышать");
  container.append(heading);

  if (currentMode === "table") {
    container.append(buildPreviewTable(locale));
    return;
  }

  const list = document.createElement("ol");
  list.className = "reading-preview-list";
  list.setAttribute("aria-label", translateText("Пример списка сообщений"));

  for (const sample of MESSAGE_READING_SAMPLE_ITEMS) {
    list.append(buildPreviewListItem(sample, currentMode, locale));
  }
  container.append(list);
}

function buildPreviewListItem(sample, mode, locale) {
  const item = document.createElement("li");
  item.className = `reading-preview-item ${sample.mine ? "is-mine" : "is-theirs"}`;
  const authorText = sample.mine ? "Вы" : sample.authorName;
  const clockText = formatShortClock(sample.createdAt);
  const statusText = deliveryStatusSummary(sample, {
    mine: sample.mine,
    isGroup: false,
    verbose: false,
    translate: translateText
  });
  const spokenSummary = buildMessageReadingText(sample, {
    mode,
    mine: sample.mine,
    authorName: sample.authorName,
    isGroup: false,
    locale,
    translate: translateText
  });

  if (mode === "parts") {
    const author = document.createElement("span");
    author.className = "reading-preview-author";
    author.textContent = authorText;
    if (!sample.mine) author.dataset.userContent = "true";
    item.append(author);

    if (sample.kind === "voice") {
      const voiceBtn = document.createElement("button");
      voiceBtn.type = "button";
      voiceBtn.className = "reading-preview-voice-btn";
      voiceBtn.textContent = `${translateText("Воспроизвести голосовое")} · ${formatDurationSpoken(sample.voice.durationMs, translateText)}`;
      voiceBtn.addEventListener("click", () => announce("Пример: так запускается воспроизведение голосового сообщения."));
      item.append(voiceBtn);
    } else {
      const body = document.createElement("p");
      body.className = "reading-preview-text";
      body.dataset.userContent = "true";
      body.textContent = sample.text;
      item.append(body);
    }

    const meta = document.createElement("span");
    meta.className = "reading-preview-meta";
    meta.textContent = [clockText, statusText].filter(Boolean).join(" · ");
    item.append(meta);
    return item;
  }

  if (sample.kind === "voice") {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "message-voice-summary-trigger";
    trigger.setAttribute("aria-label", spokenSummary);
    trigger.textContent = `${translateText("Воспроизвести голосовое")} · ${formatDurationSpoken(sample.voice.durationMs, translateText)}`;
    trigger.addEventListener("click", () => announce("Пример: так запускается воспроизведение голосового сообщения."));
    item.append(trigger);

    const visualMeta = document.createElement("span");
    visualMeta.className = "reading-preview-meta";
    visualMeta.setAttribute("aria-hidden", "true");
    visualMeta.textContent = spokenSummary;
    item.append(visualMeta);
    return item;
  }

  const surface = document.createElement("span");
  surface.className = "message-reading-surface";
  surface.textContent = spokenSummary;

  const visual = document.createElement("div");
  visual.className = "message-visual-body";
  visual.setAttribute("aria-hidden", "true");

  const author = document.createElement("span");
  author.className = "reading-preview-author";
  author.textContent = authorText;

  const body = document.createElement("p");
  body.className = "reading-preview-text";
  body.textContent = sample.text;

  const meta = document.createElement("span");
  meta.className = "reading-preview-meta";
  meta.textContent = [clockText, statusText].filter(Boolean).join(" · ");

  const spokenHint = document.createElement("span");
  spokenHint.className = "reading-preview-spoken-quote";
  spokenHint.textContent = spokenSummary;

  visual.append(author, body, meta, spokenHint);
  item.append(surface, visual);
  return item;
}

function buildPreviewTable(locale) {
  const table = document.createElement("table");
  table.className = "message-table reading-preview-table";
  table.setAttribute("aria-label", translateText("Пример таблицы сообщений"));

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["Отправитель", "Сообщение", "Время и статус"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = translateText(label);
    headerRow.append(th);
  }
  thead.append(headerRow);

  const tbody = document.createElement("tbody");
  for (const sample of MESSAGE_READING_SAMPLE_ITEMS) {
    const row = document.createElement("tr");
    row.className = sample.mine ? "message-mine" : "message-theirs";

    const authorCell = document.createElement("td");
    authorCell.textContent = sample.mine ? "Вы" : sample.authorName;
    if (!sample.mine) authorCell.dataset.userContent = "true";

    const contentCell = document.createElement("td");
    if (sample.kind === "voice") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "reading-preview-voice-btn";
      btn.textContent = `${translateText("Голосовое сообщение")} · ${formatDurationSpoken(sample.voice.durationMs, translateText)}`;
      btn.addEventListener("click", () => announce("Пример: так запускается воспроизведение голосового сообщения."));
      contentCell.append(btn);
    } else {
      contentCell.dataset.userContent = "true";
      contentCell.textContent = sample.text;
    }

    const metaCell = document.createElement("td");
    const statusText = deliveryStatusSummary(sample, {
      mine: sample.mine,
      isGroup: false,
      verbose: false,
      translate: translateText
    });
    metaCell.textContent = [formatShortClock(sample.createdAt), statusText].filter(Boolean).join(" · ");

    row.append(authorCell, contentCell, metaCell);
    tbody.append(row);
  }

  table.append(thead, tbody);
  return table;
}
