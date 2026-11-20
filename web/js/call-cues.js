// Local low-volume call state feedback: not sent to the remote participant.
let context = null;
const playing = new Set();
const tones = {
  answered: [[540, 0, 0.10], [680, 0.10, 0.13]],
  connected: [[490, 0, 0.11], [660, 0.10, 0.17]],
  declined: [[430, 0, 0.16], [330, 0.17, 0.23]],
  ended: [[425, 0, 0.16], [295, 0.18, 0.16]]
};
export function prepareCallCues() {
  try {
    if (!context || context.state === "closed") {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return Promise.resolve(false);
      context = new Ctor();
    }
    if (context.state !== "running") {
      return Promise.resolve(context.resume()).then(() => context.state === "running").catch(() => false);
    }
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}
export function stopCallCues() {
  for (const oscillator of playing) {
    try { oscillator.stop(); } catch {}
  }
  playing.clear();
}
export function playCallCue(event) {
  const sequence = tones[event];
  if (!sequence) return;
  void prepareCallCues().then((ready) => {
    if (!ready || !context || context.state !== "running") return;
    try {
      const now = context.currentTime + 0.012;
      sequence.forEach(([hz, delay, seconds]) => {
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = hz;
        envelope.gain.setValueAtTime(0.0001, now + delay);
        envelope.gain.linearRampToValueAtTime(0.07, now + delay + 0.02);
        envelope.gain.setValueAtTime(0.07, now + delay + seconds - 0.03);
        envelope.gain.linearRampToValueAtTime(0.0001, now + delay + seconds);
        oscillator.connect(envelope).connect(context.destination);
        playing.add(oscillator);
        oscillator.onended = () => playing.delete(oscillator);
        oscillator.start(now + delay);
        oscillator.stop(now + delay + seconds);
      });
    } catch {
      // UI sound must not interrupt a real call.
    }
  });
}

export function resetCallCueAudio() {
  stopCallCues();
  const old = context;
  context = null;
  try { void old?.close?.()?.catch?.(() => {}); } catch {}
}
