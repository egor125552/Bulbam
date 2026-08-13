import { api } from "./api.js";
import { announce } from "./ui.js";

const BITRATE_KEY = "bulbam.voice.bitrate";
const SHARE_KEY_PREFIX = "bulbam.voice.shareListening.";
const ALLOWED_BITRATES = new Set([24000, 32000, 48000, 64000, 96000]);

let bitrateBps = readBitrate();
let shareListening = true;
let bitrateSelect = null;
let shareCheckbox = null;
let currentAccountId = null;
let settingsGeneration = 0;

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
    shareCheckbox.checked = true;
    shareCheckbox.disabled = true;
    shareCheckbox.addEventListener("change", () => void setShareListening(shareCheckbox.checked));
  }

  window.addEventListener("bulbam:account-changed", (event) => {
    const generation = ++settingsGeneration;
    const account = event.detail?.account ?? null;
    currentAccountId = account?.userId ?? null;

    if (!currentAccountId) {
      shareListening = true;
      if (shareCheckbox) {
        shareCheckbox.checked = true;
        shareCheckbox.disabled = true;
      }
      return;
    }

    const cached = localStorage.getItem(shareKey(currentAccountId));
    shareListening = cached === null ? true : cached !== "false";
    if (shareCheckbox) {
      shareCheckbox.checked = shareListening;
      shareCheckbox.disabled = true;
    }
    void loadShareSetting(currentAccountId, generation);
  });
}

export function getVoiceBitrate() {
  return bitrateBps;
}

export function getShareListening() {
  return shareListening;
}

async function loadShareSetting(accountId, generation) {
  try {
    const result = await api("/api/v1/voice/settings");
    if (generation !== settingsGeneration || accountId !== currentAccountId) return;
    shareListening = result.shareListening !== false;
    localStorage.setItem(shareKey(accountId), String(shareListening));
    if (shareCheckbox) shareCheckbox.checked = shareListening;
  } catch {
    // Keep the account-scoped cached/default value when the server is temporarily unavailable.
  } finally {
    if (generation === settingsGeneration && accountId === currentAccountId && shareCheckbox) {
      shareCheckbox.disabled = false;
    }
  }
}

async function setShareListening(next) {
  const accountId = currentAccountId;
  const generation = settingsGeneration;
  if (!accountId) {
    if (shareCheckbox) {
      shareCheckbox.checked = true;
      shareCheckbox.disabled = true;
    }
    return;
  }

  const previous = shareListening;
  shareListening = next;
  localStorage.setItem(shareKey(accountId), String(next));
  if (shareCheckbox) shareCheckbox.disabled = true;

  try {
    const result = await api("/api/v1/voice/settings", {
      method: "PUT",
      body: JSON.stringify({ shareListening: next })
    });
    if (generation !== settingsGeneration || accountId !== currentAccountId) return;
    shareListening = result.shareListening !== false;
    localStorage.setItem(shareKey(accountId), String(shareListening));
    if (shareCheckbox) shareCheckbox.checked = shareListening;
    announce(shareListening
      ? "Собеседники снова увидят прогресс прослушивания голосовых."
      : "Прогресс прослушивания голосовых скрыт от собеседников.");
  } catch (error) {
    if (generation !== settingsGeneration || accountId !== currentAccountId) return;
    shareListening = previous;
    localStorage.setItem(shareKey(accountId), String(previous));
    if (shareCheckbox) shareCheckbox.checked = previous;
    announce(`Не удалось изменить приватность голосовых: ${error.message}`);
  } finally {
    if (generation === settingsGeneration && accountId === currentAccountId && shareCheckbox) {
      shareCheckbox.disabled = false;
    }
  }
}

function shareKey(accountId) {
  return `${SHARE_KEY_PREFIX}${accountId}`;
}

function readBitrate() {
  const stored = Number(localStorage.getItem(BITRATE_KEY));
  return ALLOWED_BITRATES.has(stored) ? stored : 64000;
}
