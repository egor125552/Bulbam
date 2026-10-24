import { replaceCallCapture } from "./call-microphone-replacement.js";

const SAFE_ERRORS = new Set([
  "NotReadableError", "NotAllowedError", "NotFoundError", "OverconstrainedError",
  "AbortError", "NotSupportedError", "InvalidModificationError", "InvalidStateError",
  "OperationError", "TypeError", "SecurityError", "NotImplementedError"
]);

// Record DOMException types only. Browser error.message can contain device
// labels, paths, or driver implementation details and is never exported.
export function mediaErrorCategory(error) {
  return SAFE_ERRORS.has(error?.name) ? error.name : "OtherError";
}

export async function switchCallAudioProfile({ oldStream, sender, acquire, applyExisting, isCurrent, muted = false }) {
  if (!isCurrent()) return { status: "stale" };
  let captureError = "NotSupportedError";
  if (sender?.replaceTrack) {
    try {
      const replaced = await replaceCallCapture({ oldStream, sender, acquire, isCurrent, muted });
      if (replaced.changed) return { status: "replaced", stream: replaced.stream, track: replaced.track };
      if (replaced.stale) return { status: "stale" };
    } catch (error) {
      captureError = mediaErrorCategory(error);
    }
  }

  if (!isCurrent()) return { status: "stale" };
  // Some devices reject a second getUserMedia() while the call owns the first.
  // Prefer retaining the live audio rather than tearing it down to reopen.
  try {
    const result = await applyExisting(oldStream.getAudioTracks()[0]);
    if (!isCurrent()) return { status: "stale" };
    return { status: "fallback", captureError, result };
  } catch (error) {
    return { status: "failed", captureError, fallbackError: mediaErrorCategory(error) };
  }
}
