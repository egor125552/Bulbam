// A soft local ringback cue only. It is never sent to the other participant.
let context = null;
let interval = null;
let ringing = false;
const activeOscillators = new Set();

export function prepareRingback() {
  try {
    if (!context) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      context = new AudioCtor();
    }
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch {
    // Ringback is optional. It must not prevent a voice call from starting.
  }
}

function pulse() {
  if (!ringing || !context) return;
  try {
    const now = context.currentTime;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = 425;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.035, now + 0.03);
    gain.gain.setValueAtTime(0.035, now + 0.83);
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.9);
    osc.connect(gain).connect(context.destination);
    activeOscillators.add(osc);
    osc.onended = () => { activeOscillators.delete(osc); };
    osc.start(now);
    osc.stop(now + 0.91);
  } catch {
    // The call itself remains independent of sound effects.
  }
}

export function startRingback() {
  if (ringing) return;
  ringing = true;
  prepareRingback();
  pulse();
  interval = setInterval(pulse, 3600);
}

export function stopRingback() {
  ringing = false;
  if (interval) clearInterval(interval);
  interval = null;
  for (const osc of activeOscillators) {
    try { osc.stop(); } catch {}
  }
  activeOscillators.clear();
}
