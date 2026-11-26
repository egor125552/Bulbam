// Micro-batcher for WebRTC ICE candidates so slow/lossy cellular connections
// send 1 compact HTTP request instead of 8-12 competing POST requests.

export function createIceCandidateBatcher({
  flush,
  windowMs = 90,
  maxBatch = 8,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let queue = [];
  let timer = null;
  let epoch = 0;

  function schedule() {
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void flushNow();
    }, windowMs);
  }

  function push(item) {
    queue.push(item);
    if (queue.length >= maxBatch) {
      void flushNow();
      return;
    }
    schedule();
  }

  async function flushNow() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const currentEpoch = epoch;
    await flush(batch, currentEpoch);
  }

  function clear() {
    epoch += 1;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    queue = [];
  }

  function pendingCount() {
    return queue.length;
  }

  return { push, flushNow, clear, pendingCount };
}
