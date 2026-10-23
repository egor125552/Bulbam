// A classic telephone ringback heard only by the caller, not transmitted via WebRTC.
// 425 Hz for 1 second, then 4 seconds of silence (5-second cycle).
// Unlike the old short two-note notification, this is a sustained call-progress tone.
const RINGBACK_HZ = 425;
const RINGBACK_DURATION_SECONDS = 1;
const RINGBACK_CYCLE_MS = 5000;
const FADE_SECONDS = 0.025;
const VOLUME = 0.12;

let context = null;
let interval = null;
let ringing = false;
let generation = 0;
const activeOscillators = new Set();

export function prepareRingback() {
  try {
    if (!context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return Promise.resolve(false);
      context = new AudioCtor();
    }
    if (context.state === "suspended") {
      return Promise.resolve(context.resume()).then(() => context?.state !== "suspended").catch(() => false);
    }
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function ringOnce() {
  if (!ringing || !context || context.state === "suspended") return;
  try {
    const now = context.currentTime;
    const end = now + RINGBACK_DURATION_SECONDS;
    const osc = context.createOscillator();
    const gain = context.createGain();

    osc.type = "sine";
    osc.frequency.value = RINGBACK_HZ;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(VOLUME, now + FADE_SECONDS);
    gain.gain.setValueAtTime(VOLUME, end - FADE_SECONDS);
    gain.gain.linearRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(context.destination);
    activeOscillators.add(osc);
    osc.onended = () => activeOscillators.delete(osc);
    osc.start(now);
    osc.stop(end);
  } catch {
    // Failure to play a local ringback must never interrupt the call.
  }
}

export function startRingback() {
  if (ringing) return;
  ringing = true;
  const token = ++generation;
  void prepareRingback().then((ready) => {
    if (!ready || !ringing || token !== generation) return;
    ringOnce();
    if (!interval) interval = setInterval(ringOnce, RINGBACK_CYCLE_MS);
  });
}

export function stopRingback() {
  ringing = false;
  generation += 1;
  if (interval) clearInterval(interval);
  interval = null;
  for (const osc of activeOscillators) {
    try { osc.stop(); } catch {}
  }
  activeOscillators.clear();
}
