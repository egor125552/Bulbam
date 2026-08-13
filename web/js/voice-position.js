export function effectiveVoicePositionMs(currentTimeSeconds, fallbackMs = 0) {
  const actualMs = Math.max(0, Number(currentTimeSeconds) * 1000 || 0);
  const savedMs = Math.max(0, Number(fallbackMs) || 0);
  return actualMs > 0 || savedMs === 0 ? actualMs : savedMs;
}

export function voiceSeekTargetMs(currentTimeSeconds, fallbackMs, deltaSeconds, durationMs) {
  const baseMs = effectiveVoicePositionMs(currentTimeSeconds, fallbackMs);
  const limitMs = Math.max(0, Number(durationMs) || 0);
  const nextMs = baseMs + (Number(deltaSeconds) || 0) * 1000;
  return Math.min(limitMs, Math.max(0, nextMs));
}
