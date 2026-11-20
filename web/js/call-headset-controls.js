// Browser-standard Media Session conferencing controls. Availability depends
// on OS/browser/headset: the headset's physical mute switch is not exposed.
// While a call is active, regular play/pause keys are a fallback for earbuds
// that send a media key rather than the dedicated togglemicrophone action.
export function createCallHeadsetControls(navigatorLike, { onMute, onHangup } = {}) {
  let session = null;
  let active = false;
  let muted = false;
  const registered = new Set();

  function safely(action, handler) {
    try {
      session?.setActionHandler?.(action, handler);
      if (handler) registered.add(action);
      return true;
    } catch { return false; }
  }

  function updateMuted(nextMuted) {
    muted = Boolean(nextMuted);
    if (!active || !session) return;
    try { session.setMicrophoneActive?.(!muted); } catch {}
    try { session.playbackState = muted ? "paused" : "playing"; } catch {}
  }

  return {
    activate(isMuted) {
      if (active) { updateMuted(isMuted); return Boolean(session); }
      session = navigatorLike?.mediaSession ?? null;
      if (!session?.setActionHandler) return false;
      active = true;
      safely("togglemicrophone", () => { if (active) onMute?.(!muted); });
      safely("pause", () => { if (active) onMute?.(true); });
      safely("play", () => { if (active) onMute?.(false); });
      safely("hangup", () => { if (active) onHangup?.(); });
      updateMuted(isMuted);
      return registered.size > 0;
    },
    updateMuted,
    deactivate() {
      active = false;
      for (const action of registered) safely(action, null);
      registered.clear();
      try { session?.setMicrophoneActive?.(false); } catch {}
      try { if (session) session.playbackState = "none"; } catch {}
      session = null;
    }
  };
}
