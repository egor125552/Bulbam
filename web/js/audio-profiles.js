import { announce, elements } from "./ui.js";
import { preferMonoCallCapture } from "./call-audio-channels.js";
import {
  AUDIO_PROFILES,
  buildAudioConstraints,
  getAudioProfile,
  normalizeAudioProfile,
  summarizeTrackSettings
} from "./audio-profile-core.js";

const STORAGE_KEY = "bulbam.callAudioProfile";
let selectedProfileId = readStoredProfile();

export function setupAudioProfiles() {
  if (!elements.audioProfileSelect) return;

  elements.audioProfileSelect.value = selectedProfileId;
  renderProfileDescription();
  renderIdleStatus();

  elements.audioProfileSelect.addEventListener("change", () => {
    selectedProfileId = normalizeAudioProfile(elements.audioProfileSelect.value);
    localStorage.setItem(STORAGE_KEY, selectedProfileId);
    renderProfileDescription();
    renderIdleStatus();
    const profile = getAudioProfile(selectedProfileId);
    window.dispatchEvent(new CustomEvent("bulbam:audio-profile-changed", {
      detail: { profileId: selectedProfileId }
    }));
    announce(`Режим звука «${profile.label}» выбран.`);
  });

  elements.audioProfileTestButton?.addEventListener("click", () => {
    void testMicrophoneProfile();
  });
}

export function getSelectedAudioProfile() {
  return getAudioProfile(selectedProfileId);
}

export async function requestCallMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("этот браузер не предоставляет доступ к микрофону");
  }

  const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? null;
  const constraints = buildAudioConstraints(selectedProfileId, supported);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: constraints,
    video: false
  });
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new Error("браузер не вернул аудиодорожку микрофона");
  }

  await preferMonoCallCapture(track, selectedProfileId);
  applyContentHint(track);
  updateAudioProfileStatus(track);
  return stream;
}

export async function applySelectedAudioProfileToTrack(track) {
  if (!track) return null;
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? null;
  const constraints = buildAudioConstraints(selectedProfileId, supported);

  if (typeof track.applyConstraints === "function") {
    await track.applyConstraints(constraints);
  }
  await preferMonoCallCapture(track, selectedProfileId);
  applyContentHint(track);
  return updateAudioProfileStatus(track);
}

export async function tuneAudioSender(sender) {
  if (!sender?.getParameters || !sender?.setParameters) return false;
  const profile = getSelectedAudioProfile();
  const parameters = sender.getParameters();
  if (!Array.isArray(parameters.encodings) || !parameters.encodings.length) return false;

  const nextEncodings = parameters.encodings.map((encoding) => ({
    ...encoding,
    maxBitrate: profile.maxBitrate
  }));

  await sender.setParameters({
    ...parameters,
    encodings: nextEncodings
  });
  return true;
}

export function updateAudioProfileStatus(track) {
  if (!track || !elements.audioProfileStatus) return null;
  const profile = getSelectedAudioProfile();
  const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
  const summary = summarizeTrackSettings(selectedProfileId, settings);
  const device = track.label ? ` Микрофон: ${track.label}.` : "";

  let verdict = "";
  if (summary.mismatches.length) {
    verdict = ` Браузер не выполнил полностью: ${summary.mismatches.join(", ")}.`;
  } else if (summary.unknown.length) {
    verdict = " Часть обработки браузер не позволяет подтвердить через Web API.";
  } else {
    verdict = " Запрошенная обработка подтверждена браузером.";
  }

  elements.audioProfileStatus.textContent = `${profile.label}. Фактически: ${summary.text}.${verdict}${device}`;
  return { profile, settings, ...summary };
}

async function testMicrophoneProfile() {
  if (!elements.audioProfileTestButton) return;
  elements.audioProfileTestButton.disabled = true;
  try {
    const stream = await requestCallMicrophone();
    const track = stream.getAudioTracks()[0];
    const result = updateAudioProfileStatus(track);
    stopStream(stream);
    const profile = getSelectedAudioProfile();
    if (result?.mismatches?.length) {
      announce(`Проверка «${profile.label}»: браузер применил режим только частично.`);
    } else {
      announce(`Проверка «${profile.label}» завершена. Фактические параметры показаны в настройках.`);
    }
  } catch (error) {
    elements.audioProfileStatus.textContent = `Не удалось проверить микрофон: ${friendlyMediaError(error)}.`;
    announce(`Не удалось проверить микрофон: ${friendlyMediaError(error)}.`);
  } finally {
    elements.audioProfileTestButton.disabled = false;
  }
}

function applyContentHint(track) {
  const hint = getSelectedAudioProfile().contentHint;
  if (!("contentHint" in track)) return;
  try {
    track.contentHint = hint;
  } catch {
    // Content hints are advisory. Unsupported values must not break a call.
  }
}

function renderProfileDescription() {
  const profile = getSelectedAudioProfile();
  if (elements.audioProfileDescription) {
    elements.audioProfileDescription.textContent = profile.description;
  }
}

function renderIdleStatus() {
  if (!elements.audioProfileStatus) return;
  const profile = getSelectedAudioProfile();
  elements.audioProfileStatus.textContent = `Выбран режим «${profile.label}». Нажмите «Проверить микрофон», чтобы увидеть фактически применённые параметры на этом устройстве.`;
}

function readStoredProfile() {
  try {
    return normalizeAudioProfile(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "normal";
  }
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

function friendlyMediaError(error) {
  if (error?.name === "NotAllowedError") return "нет разрешения на микрофон";
  if (error?.name === "NotFoundError") return "микрофон не найден";
  if (error?.name === "OverconstrainedError") return "устройство не поддерживает выбранные параметры";
  return error?.message ?? "неизвестная ошибка";
}

export { AUDIO_PROFILES };
