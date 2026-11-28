// Background keepalive audio tracks are intentionally disabled during calls
// so callers never hear background hum/static and headset controls stay clean.
export function createCallKeepaliveAudio(audio, navigatorLike) {
  let active = false;
  function silence() {
    if (!audio) return;
    try { audio.muted = true; } catch {}
    try { audio.volume = 0; } catch {}
    try { audio.loop = false; } catch {}
    try { audio.pause?.(); } catch {}
    try { audio.currentTime = 0; } catch {}
  }
  return {
    activate() {
      active = false;
      silence();
      return false;
    },
    async resume() {
      silence();
    },
    deactivate() {
      active = false;
      silence();
      try { if (navigatorLike?.mediaSession) navigatorLike.mediaSession.metadata = null; } catch {}
    },
    get active() { return active; }
  };
}
