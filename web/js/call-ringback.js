// Local outgoing connection cue. It is never sent to the other participant.
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

function tone(startOffset, frequency, duration = 0.16) {
  if (!context || context.state === "suspended") return;
  const now = context.currentTime + startOffset;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.075, now + 0.025);
  gain.gain.setValueAtTime(0.075, now + duration - 0.035);
  gain.gain.linearRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain).connect(context.destination);
  activeOscillators.add(osc);
  osc.onended = () => activeOscillators.delete(osc);
  osc.start(now);
  osc.stop(now + duration + 0.01);
}

function pulse() {
  if (!ringing || !context || context.state === "suspended") return;
  try {
    tone(0, 440);
    tone(0.28, 523.25);
  } catch {
    // Connection itself is independent of the local cue.
  }
}

export function startRingback() {
  if (ringing) return;
  ringing = true;
  const token = ++generation;
  void prepareRingback().then((ready) => {
    if (!ready || !ringing || token !== generation) return;
    pulse();
    if (!interval) interval = setInterval(pulse, 2800);
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
