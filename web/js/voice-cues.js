let context = null;

export async function playVoiceCue(kind) {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") await context.resume();
    const patterns = {
      start: [[660, 0, 0.055], [880, 0.07, 0.06]],
      stop: [[880, 0, 0.055], [660, 0.07, 0.06]],
      cancel: [[330, 0, 0.06], [330, 0.1, 0.06]],
      error: [[220, 0, 0.09], [180, 0.12, 0.11]]
    };
    const pattern = patterns[kind] ?? patterns.error;
    const now = context.currentTime;
    for (const [frequency, offset, duration] of pattern) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + duration + 0.01);
    }
  } catch {
    // Sounds are useful feedback, but recording must never depend on Web Audio.
  }
}
