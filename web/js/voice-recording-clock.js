export function createRecordingClock(startedAt = Date.now()) {
  let pausedAt = null;
  let pausedTotal = 0;
  return {
    get paused() { return pausedAt !== null; },
    pause(at = Date.now()) {
      if (pausedAt !== null) return false;
      pausedAt = at;
      return true;
    },
    resume(at = Date.now()) {
      if (pausedAt === null) return false;
      pausedTotal += Math.max(0, at - pausedAt);
      pausedAt = null;
      return true;
    },
    elapsed(at = Date.now()) {
      const effectiveNow = pausedAt ?? at;
      return Math.max(0, effectiveNow - startedAt - pausedTotal);
    }
  };
}
