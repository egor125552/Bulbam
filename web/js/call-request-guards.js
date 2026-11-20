// Keep asynchronous responses from an earlier call from mutating a newer one.
export function matchesCallResponse(active, requestedCallId, received) {
  return Boolean(requestedCallId && active?.callId === requestedCallId &&
    received?.callId === requestedCallId);
}

export function createRequestEpoch() {
  let generation = 0;
  return {
    token() { return generation; },
    invalidate() { generation++; },
    isCurrent(token) { return token === generation; }
  };
}
