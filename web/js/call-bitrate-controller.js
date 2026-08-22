const SAMPLE_INTERVAL_MS = 2_000;
const controllers = new WeakMap();

export function bitrateBounds(profile) {
  const maxBitrate = Math.max(12_000, Number(profile?.maxBitrate) || 64_000);
  const floorBitrate = Math.max(12_000, Math.round(maxBitrate * 0.25 / 1_000) * 1_000);
  return { floorBitrate: Math.min(floorBitrate, maxBitrate), maxBitrate };
}

export function classifySenderNetwork(sample) {
  const loss = finiteOrNull(sample?.fractionLost);
  const rtt = finiteOrNull(sample?.roundTripTime);
  if (loss === null && rtt === null) return "unknown";
  if ((loss !== null && loss >= 0.08) || (rtt !== null && rtt >= 0.45)) return "severe";
  if ((loss !== null && loss >= 0.025) || (rtt !== null && rtt >= 0.25)) return "degraded";
  if ((loss === null || loss <= 0.015) && (rtt === null || rtt <= 0.18)) return "good";
  return "neutral";
}

export function nextAdaptiveBitrate(state, health) {
  const next = { ...state };
  const current = Number(state.currentBitrate);
  const floor = Number(state.floorBitrate);
  const max = Number(state.maxBitrate);

  if (health === "severe") {
    next.badSamples = (state.badSamples || 0) + 1;
    next.goodSamples = 0;
    next.currentBitrate = Math.max(floor, roundKbps(current * 0.6));
    return next;
  }

  if (health === "degraded") {
    next.badSamples = (state.badSamples || 0) + 1;
    next.goodSamples = 0;
    if (next.badSamples >= 2) {
      next.currentBitrate = Math.max(floor, roundKbps(current * 0.82));
      next.badSamples = 0;
    }
    return next;
  }

  if (health === "good") {
    next.badSamples = 0;
    next.goodSamples = (state.goodSamples || 0) + 1;
    if (next.goodSamples >= 5) {
      next.currentBitrate = Math.min(max, Math.max(current + 4_000, roundKbps(current * 1.12)));
      next.goodSamples = 0;
    }
    return next;
  }

  next.badSamples = 0;
  next.goodSamples = 0;
  return next;
}

export async function configureAdaptiveBitrate(sender, profile) {
  if (!sender?.getParameters || !sender?.setParameters) return false;
  const bounds = bitrateBounds(profile);
  let state = controllers.get(sender);
  if (!state) {
    state = {
      ...bounds,
      currentBitrate: bounds.maxBitrate,
      badSamples: 0,
      goodSamples: 0,
      timer: null,
      failures: 0,
      sampling: false
    };
    controllers.set(sender, state);
  } else {
    state.maxBitrate = bounds.maxBitrate;
    state.floorBitrate = bounds.floorBitrate;
    state.currentBitrate = Math.min(state.maxBitrate, Math.max(state.floorBitrate, state.currentBitrate));
    state.badSamples = 0;
    state.goodSamples = 0;
  }

  const applied = await applyBitrate(sender, state.currentBitrate);
  if (!applied) return false;
  if (typeof sender.getStats === "function" && !state.timer) {
    state.timer = setInterval(() => void sampleSender(sender, state), SAMPLE_INTERVAL_MS);
    void sampleSender(sender, state);
  }
  return true;
}

async function sampleSender(sender, state) {
  if (state.sampling) return;
  if (sender.track?.readyState === "ended" || sender.transport?.state === "closed") {
    stopController(sender, state);
    return;
  }

  state.sampling = true;
  try {
    const stats = await sender.getStats();
    const sample = extractSenderNetworkSample(stats);
    const health = classifySenderNetwork(sample);
    const next = nextAdaptiveBitrate(state, health);
    const bitrateChanged = next.currentBitrate !== state.currentBitrate;
    state.floorBitrate = next.floorBitrate;
    state.maxBitrate = next.maxBitrate;
    state.badSamples = next.badSamples;
    state.goodSamples = next.goodSamples;
    state.failures = 0;
    if (bitrateChanged && await applyBitrate(sender, next.currentBitrate)) {
      state.currentBitrate = next.currentBitrate;
    }
  } catch {
    state.failures += 1;
    if (state.failures >= 5 && sender.transport?.state === "closed") stopController(sender, state);
  } finally {
    state.sampling = false;
  }
}

export function extractSenderNetworkSample(stats) {
  let remoteInbound = null;
  let candidatePair = null;
  stats?.forEach?.((report) => {
    const kind = report.kind ?? report.mediaType;
    if (!remoteInbound && report.type === "remote-inbound-rtp" && (kind === "audio" || !kind)) {
      remoteInbound = report;
    }
    if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || !candidatePair)) {
      candidatePair = report;
    }
  });

  const fractionLost = finiteOrNull(remoteInbound?.fractionLost);
  const remoteRtt = finiteOrNull(remoteInbound?.roundTripTime);
  const pairRtt = finiteOrNull(candidatePair?.currentRoundTripTime);
  return {
    fractionLost,
    roundTripTime: remoteRtt ?? pairRtt
  };
}

async function applyBitrate(sender, bitrate) {
  try {
    const parameters = sender.getParameters();
    if (!Array.isArray(parameters.encodings) || !parameters.encodings.length) return false;
    const encodings = parameters.encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: Math.max(1_000, Math.round(bitrate))
    }));
    await sender.setParameters({ ...parameters, encodings });
    return true;
  } catch {
    return false;
  }
}

function stopController(sender, state) {
  clearInterval(state.timer);
  state.timer = null;
  controllers.delete(sender);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundKbps(value) {
  return Math.max(1_000, Math.round(value / 1_000) * 1_000);
}
