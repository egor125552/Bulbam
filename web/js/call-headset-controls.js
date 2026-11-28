// Browser-standard Media Session conferencing controls. Availability depends
// on OS/browser/headset. While a call is active, regular play/pause keys are
// mapped to microphone mute/unmute for earbuds that send media keys instead of
// the dedicated togglemicrophone action.
//
// Important iOS/Safari detail: active remote <audio> playback can keep the OS
// media session in "playing" state even while the microphone is muted, so a
// second press on AirPods/Bluetooth headphones often fires "pause" again.
// Treating a subsequent "pause" (after a short debounce) as an unmute toggle
// prevents the microphone from getting stuck muted.
const HEADSET_REPEAT_PAUSE_DEBOUNCE_MS = 350;

export function createCallHeadsetControls(
  navigatorLike,
  { onMute, onHangup, onMediaKey, now = () => Date.now() } = {}
) {
  let session = null;
  let active = false;
  let muted = false;
  let lastMuteCommandAt = -Infinity;
  const registered = new Set();

  function safely(action, handler) {
    try {
      session?.setActionHandler?.(action, handler);
      if (handler) registered.add(action);
      return true;
    } catch { return false; }
  }

  function safelySetMicrophoneActive(targetSession, isActive) {
    if (!targetSession || typeof targetSession.setMicrophoneActive !== "function") return;
    try {
      const maybePromise = targetSession.setMicrophoneActive(Boolean(isActive));
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch {}
  }

  function updateMuted(nextMuted) {
    muted = Boolean(nextMuted);
    if (!active || !session) return;
    safelySetMicrophoneActive(session, !muted);
    try { session.playbackState = muted ? "paused" : "playing"; } catch {}
  }

  function triggerMute(nextMuted) {
    lastMuteCommandAt = now();
    onMute?.(Boolean(nextMuted));
    onMediaKey?.();
  }

  return {
    activate(isMuted) {
      if (active) { updateMuted(isMuted); return Boolean(session); }
      session = navigatorLike?.mediaSession ?? null;
      if (!session?.setActionHandler) return false;
      active = true;
      lastMuteCommandAt = -Infinity;
      safely("togglemicrophone", () => {
        if (!active) return;
        triggerMute(!muted);
      });
      safely("pause", () => {
        if (!active) return;
        if (!muted) {
          triggerMute(true);
          return;
        }
        if ((now() - lastMuteCommandAt) >= HEADSET_REPEAT_PAUSE_DEBOUNCE_MS) {
          triggerMute(false);
        } else {
          onMediaKey?.();
        }
      });
      safely("play", () => {
        if (!active) return;
        if (muted) {
          triggerMute(false);
        } else {
          onMediaKey?.();
        }
      });
      safely("hangup", () => {
        if (active) onHangup?.();
      });
      updateMuted(isMuted);
      return registered.size > 0;
    },
    updateMuted,
    deactivate() {
      active = false;
      lastMuteCommandAt = -Infinity;
      const previousSession = session;
      for (const action of registered) safely(action, null);
      registered.clear();
      safelySetMicrophoneActive(previousSession, false);
      try { if (previousSession) previousSession.playbackState = "none"; } catch {}
      session = null;
    }
  };
}
