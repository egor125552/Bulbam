import { replaceCallCapture } from "./call-microphone-replacement.js";

const SAFE_ERRORS = new Set([
  "NotReadableError", "NotAllowedError", "NotFoundError", "OverconstrainedError",
  "AbortError", "NotSupportedError", "InvalidModificationError", "InvalidStateError",
  "OperationError", "TypeError", "SecurityError", "NotImplementedError",
  "Error", "NetworkError"
]);

// Record DOMException types only. Browser error.message can contain device
// labels, paths, or driver implementation details and is never exported.
export function mediaErrorCategory(error) {
  return SAFE_ERRORS.has(error?.name) ? error.name : "OtherError";
}

export async function switchCallAudioProfile({ oldStream, sender, acquire, applyExisting, isCurrent, muted = false, trace = () => {} }) {
  if (!isCurrent()) { trace('переключение устарело'); return { status: "stale" }; }
  trace('переключение начало');
  let captureError = "NotSupportedError";
  if (sender?.replaceTrack) {
    trace('новый захват начало');
    try {
      const replaced = await replaceCallCapture({ oldStream, sender, acquire, isCurrent, muted });
      if (replaced.changed) { trace('новый захват успешно'); return { status: "replaced", stream: replaced.stream, track: replaced.track }; }
      if (replaced.stale) { trace('новый захват устарел'); return { status: "stale" }; }
    } catch (error) {
      captureError = mediaErrorCategory(error);
      trace('новый захват ошибка',captureError);
    }
  }

  if (!isCurrent()) { trace('переключение устарело'); return { status: "stale" }; }
  trace('запасной способ начало');
  // Some devices reject a second getUserMedia() while the call owns the first.
  // Prefer retaining the live audio rather than tearing it down to reopen.
  try {
    const result = await applyExisting(oldStream.getAudioTracks()[0]);
    if (!isCurrent()) return { status: "stale" };
    trace('запасной способ успешно');
    return { status: "fallback", captureError, result };
  } catch (error) {
    trace('запасной способ ошибка',mediaErrorCategory(error));
    return { status: "failed", captureError, fallbackError: mediaErrorCategory(error) };
  }
}
