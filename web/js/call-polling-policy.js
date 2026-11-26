// Pure adaptive call polling cadence:
// fast during dialing, negotiation, or WebSocket outage;
// ultra-light safety fallback once audio is connected over a live WebSocket.

export const FAST_SIGNAL_POLL_MS = 1_500;
export const FAST_STATE_POLL_MS = 2_500;
export const RINGING_REALTIME_STATE_POLL_MS = 4_000;
export const STEADY_SAFETY_POLL_MS = 15_000;

export function computeCallPollingIntervals({
  status = "idle",
  peerConnected = false,
  realtimeOpen = false,
  recoveryPending = false
} = {}) {
  if (status === "accepted") {
    if (peerConnected && realtimeOpen && !recoveryPending) {
      return {
        signalMs: STEADY_SAFETY_POLL_MS,
        stateMs: STEADY_SAFETY_POLL_MS
      };
    }
    return {
      signalMs: FAST_SIGNAL_POLL_MS,
      stateMs: FAST_STATE_POLL_MS
    };
  }

  if (status === "ringing") {
    return {
      signalMs: null,
      stateMs: realtimeOpen ? RINGING_REALTIME_STATE_POLL_MS : FAST_STATE_POLL_MS
    };
  }

  return { signalMs: null, stateMs: null };
}
