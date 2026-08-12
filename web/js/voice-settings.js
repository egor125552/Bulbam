import { api } from "./api.js";
import { announce } from "./ui.js";

const BITRATE_KEY = "bulbam.voice.bitrate";
const SHARE_KEY = "bulbam.voice.shareListening";
const ALLOWED_BITRATES = new Set([24000, 32000, 48000, 64000, 96000]);

let bitrateBps = readBitrate();
let shareListening = localStorage.getItem(SHARE_KEY) !== "false";
let bitrateSelect = null;
let shareCheckbox = null;

export function setupVoiceSettings() {
  bitrateSelect = document.querySelector("#voice-bitrate");
  shareCheckbox = document.querySelector("#voice-share-listening");
  if (bitrateSelect) {
    bitrateSelect.value = String(bitrateBps);
    bitrateSelect.addEventListener("change", () => {
      const next = Number(bitrateSelect.value);
      if (!ALLOWED_BITRATES.has(next)) return;
      bitrateBps = next;
      localStorage.setItem(BITRATE_KEY, String(next));
      announce(`Качество голосовых: ${next / 1000} килобита в секунду.`);
    });
  }
  if (shareCheckbox) {
    shareCheckbox.checked = shareListening;
    shareCheckbox.addEventListener("change", () => void setShareListening(shareCheckbox.checked));
  }

  window.addEventListener("bulbam:account-changed", (event) => {
    if (!event.detail?.account) return;
    void loadShareSetting();
  });
}

export function getVoiceBitrate() {
  return bitrateBps;
}

export function getShareListening() {
  return shareListening;
}

async function loadShareSetting() {
  try {
    const result = await api("/api/v1/voice/settings");
    shareListening = result.shareListening !== false;
    localStorage.setItem(SHARE_KEY, String(shareListening));
    if (shareCheckbox) shareCheckbox.checked = shareListening;
  } catch {
    if (shareCheckbox) shareCheckbox.checked = shareListening;
  }
}

async function setShareListening(next) {
  const previous = shareListening;
  shareListening = next;
  localStorage.setItem(SHARE_KEY, String(next));
  try {
    await api("/api/v1/voice/settings", {
      method: "PUT",
      body: JSON.stringify({ shareListening: next })
    });
    announce(next
      ? "Собеседники снова увидят прогресс прослушивания голосовых."
      : "Прогресс прослушивания голосовых скрыт от собеседников.");
  } catch (error) {
    shareListening = previous;
    localStorage.setItem(SHARE_KEY, String(previous));
    if (shareCheckbox) shareCheckbox.checked = previous;
    announce(`Не удалось изменить приватность голосовых: ${error.message}`);
  }
}

function readBitrate() {
  const stored = Number(localStorage.getItem(BITRATE_KEY));
  return ALLOWED_BITRATES.has(stored) ? stored : 64000;
}
