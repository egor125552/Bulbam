// One timer per accepted call. A connection stuck in "checking"/"connecting"
// never emits a failure, so ICE failure listeners alone cannot recover it.
export function createCallConnectionWatchdog(onTimeout, timeoutMs = 12_000) {
  let timer = null;
  let generation = 0;
  return {
    arm(callId) {
      if (timer !== null) return;
      const token = ++generation;
      timer = setTimeout(() => {
        timer = null;
        if (generation === token) onTimeout(callId);
      }, timeoutMs);
    },
    disarm() {
      ++generation;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    get armed() { return timer !== null; }
  };
}
