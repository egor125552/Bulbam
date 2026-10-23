// Rate-limit recovery for one call while its new ICE/SDP offer settles.
// A caller and callee can independently emit reconnect requests. Neither
// duplicated realtime events nor the local watchdog should tear down an
// in-flight replacement peer every few milliseconds.
export function createRecoveryGate(cooldownMs = 11_000) {
  let callId = null;
  let lastAttemptAt = -Infinity;
  return {
    admit(id, now = Date.now()) {
      if (!id) return false;
      if (id !== callId) {
        callId = id;
        lastAttemptAt = -Infinity;
      }
      if (now - lastAttemptAt < cooldownMs) return false;
      lastAttemptAt = now;
      return true;
    },
    reset() { callId = null; lastAttemptAt = -Infinity; }
  };
}
