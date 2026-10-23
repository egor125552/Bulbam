import { announce } from "./ui.js";

const KEY = "bulbam.accessibility.detailedHelp";
const LEGACY_KEY = "bulbam.accessibility.detailedRecordingHelp";
const EXTRA_HINT_IDS = new Set(["message-send-hint", "voice-record-hint"]);
let enabled = true;

export function setupDetailedHelp() {
  enabled = readPreference();
  const checkbox = document.querySelector("#voice-detailed-help");
  if (checkbox) {
    checkbox.checked = enabled;
    checkbox.addEventListener("change", () => {
      enabled = checkbox.checked;
      savePreference(enabled);
      applyDetailedHelp();
      announce(enabled ? "Подробные подсказки включены." : "Подробные подсказки выключены.");
    });
  }
  applyDetailedHelp();
}

export function isDetailedHelpEnabled() { return enabled; }

function readPreference() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) return saved !== "false";
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) return legacy !== "false";
  } catch {}
  return true;
}

function savePreference(value) {
  try {
    localStorage.setItem(KEY, String(value));
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
}

function markDetailedHints() {
  for (const hint of document.querySelectorAll(".hint:not([role])")) hint.dataset.detailedHelp = "true";
  for (const id of EXTRA_HINT_IDS) {
    const hint = document.getElementById(id);
    if (hint) hint.dataset.detailedHelp = "true";
  }
}

function applyDetailedHelp() {
  markDetailedHints();
  // The root <html> also has data-detailed-help, but it is a *state*
  // indicator, never a hint. Hiding it would make the entire app disappear.
  document.documentElement.dataset.detailedHelp = String(enabled);
  document.documentElement.hidden = false;
  for (const hint of document.querySelectorAll('[data-detailed-help="true"]')) {
    if (hint !== document.documentElement) hint.hidden = !enabled;
  }
  for (const element of document.querySelectorAll("[aria-describedby], [data-detailed-help-describedby]")) {
    const stored = element.getAttribute("data-detailed-help-describedby");
    const original = stored ?? element.getAttribute("aria-describedby") ?? "";
    if (stored === null) element.setAttribute("data-detailed-help-describedby", original);
    if (enabled) {
      if (original) element.setAttribute("aria-describedby", original);
      else element.removeAttribute("aria-describedby");
      continue;
    }
    const remaining = original.split(/\s+/).filter(Boolean).filter((id) => {
      const target = document.getElementById(id);
      return !target?.hasAttribute("data-detailed-help");
    });
    if (remaining.length) element.setAttribute("aria-describedby", remaining.join(" "));
    else element.removeAttribute("aria-describedby");
  }
  window.dispatchEvent(new CustomEvent("bulbam:detailed-help-changed", { detail: { enabled } }));
}
