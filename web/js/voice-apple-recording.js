import { isAppleWebKitVoiceEnvironment } from "./voice-webkit-timeline.js";

export function setupAppleVoiceRecordingPreference() {
  if (!isAppleWebKitVoiceEnvironment()) return;
  if (!window.MediaRecorder?.isTypeSupported) return;

  const nativeCheck = MediaRecorder.isTypeSupported.bind(MediaRecorder);
  if (!shouldPreferOggOnApple(nativeCheck)) return;
  if (MediaRecorder.isTypeSupported.__bulbamAppleVoicePreference) return;

  const preferredCheck = (mimeType) => {
    const normalized = normalizeMimeType(mimeType);
    if (normalized === "audio/webm;codecs=opus") return false;
    return nativeCheck(mimeType);
  };
  preferredCheck.__bulbamAppleVoicePreference = true;

  try {
    MediaRecorder.isTypeSupported = preferredCheck;
  } catch {
    // Preference is optional. Native format detection remains available.
  }
}

export function shouldPreferOggOnApple(isTypeSupported) {
  return Boolean(
    typeof isTypeSupported === "function" &&
    isTypeSupported("audio/ogg;codecs=opus")
  );
}

function normalizeMimeType(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "");
}
