// Pure, deterministic jitter-buffer controller for WebRTC voice receivers.
//
// Why this exists:
// - Raising receiver.jitterBufferTarget during packet loss/jitter prevents
//   choppy robotic speech on congested LTE/TURN links.
// - Never resetting or relaxing it traps the call in permanent 250-300 ms lag
//   even after the network recovers or a brand-new RTCPeerConnection is built.

export const JITTER_BUFFER_ELEVATED_MS = 120;
export const JITTER_BUFFER_HIGH_MS = 240;

export function createJitterBufferController({
  elevatedMs = JITTER_BUFFER_ELEVATED_MS,
  highMs = JITTER_BUFFER_HIGH_MS
} = {}) {
  let targetMs = null;
  let degradedSamples = 0;
  let healthySamples = 0;

  function setTarget(next) {
    const normalized = next === null ? null : Math.max(0, Math.round(Number(next) || 0));
    const changed = normalized !== targetMs;
    targetMs = normalized;
    return { targetMs, changed };
  }

  return {
    get targetMs() {
      return targetMs;
    },

    reset() {
      degradedSamples = 0;
      healthySamples = 0;
      return setTarget(null);
    },

    onNetworkStress(severity) {
      degradedSamples = 0;
      healthySamples = 0;
      const desired = severity === "severe" ? highMs : elevatedMs;
      if (targetMs === null || desired > targetMs) {
        return setTarget(desired);
      }
      return { targetMs, changed: false };
    },

    onConnected({ recovered = false } = {}) {
      degradedSamples = 0;
      healthySamples = 0;
      if (!recovered) {
        return setTarget(null);
      }
      // After a recovery settles into "connected", drop immediately from high
      // stress buffer to elevated so speech drains back to auto within ~4s.
      if (targetMs !== null && targetMs > elevatedMs) {
        return setTarget(elevatedMs);
      }
      return { targetMs, changed: false };
    },

    onStatsSample({ lossRate = 0, jitterMs = 0, packetDelta = 0 } = {}) {
      if (!Number.isFinite(packetDelta) || packetDelta <= 0) {
        return { targetMs, changed: false };
      }
      const loss = Number.isFinite(lossRate) ? Math.max(0, lossRate) : 0;
      const jitter = Number.isFinite(jitterMs) ? Math.max(0, jitterMs) : 0;

      if (loss >= 0.08 || jitter >= 95) {
        degradedSamples = 0;
        healthySamples = 0;
        return setTarget(highMs);
      }

      if (loss >= 0.03 || jitter >= 65) {
        healthySamples = 0;
        degradedSamples += 1;
        // Require 2 consecutive degraded samples (~4s) before stepping up from
        // default auto mode so a single brief mobile jitter blip adds zero lag.
        if (targetMs === null && degradedSamples < 2) {
          return { targetMs, changed: false };
        }
        degradedSamples = 0;
        if (targetMs === null || targetMs < elevatedMs) {
          return setTarget(elevatedMs);
        }
        return { targetMs, changed: false };
      }

      // Healthy OR stable TURN link (very low loss with moderate jitter < 65 ms):
      // never trap the receiver at elevated/high lag once packets stop dropping.
      const canRelax = (loss < 0.025 && jitter < 50) || (loss < 0.015 && jitter < 65);
      if (canRelax) {
        degradedSamples = 0;
        if (targetMs === null) {
          healthySamples = 0;
          return { targetMs, changed: false };
        }
        healthySamples += 1;
        if (healthySamples >= 2) {
          healthySamples = 0;
          if (targetMs > elevatedMs) {
            return setTarget(elevatedMs);
          }
          return setTarget(null);
        }
        return { targetMs, changed: false };
      }

      // Neutral zone: neither escalate nor decay, keep counters calm.
      degradedSamples = 0;
      return { targetMs, changed: false };
    }
  };
}

export function applyJitterBufferTarget(receiver, targetMs) {
  if (!receiver) return false;
  if ("jitterBufferTarget" in receiver) {
    if (targetMs === null) {
      try {
        receiver.jitterBufferTarget = null;
        return true;
      } catch {
        try {
          receiver.jitterBufferTarget = 0;
          return true;
        } catch {
          return false;
        }
      }
    }
    try {
      receiver.jitterBufferTarget = targetMs;
      return true;
    } catch {
      return false;
    }
  }
  if ("playoutDelayHint" in receiver) {
    try {
      receiver.playoutDelayHint = targetMs === null ? 0 : targetMs / 1000;
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function formatJitterBufferLabel(targetMs) {
  return targetMs === null ? "авто" : `${targetMs} мс`;
}
