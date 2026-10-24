// Web microphone constraints are requests, not hardware guarantees. Do not
// insert any software EQ, compressor, AGC, noise gate or echo canceller.
export function rawVoiceConstraints(supported = null) {
  const desired = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: { ideal: 48_000 },
    channelCount: { ideal: 2 }
  };
  return Object.fromEntries(Object.entries(desired).filter(([key]) => !supported || supported[key] === true));
}

export async function keepVoiceRaw(track) {
  if (!track) throw new Error("микрофон не дал аудиодорожку");
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? null;
  const constraints = rawVoiceConstraints(supported);
  // Applying optional requests individually avoids an unsupported channel
  // count causing the browser to ignore all three raw-capture settings.
  if (track.applyConstraints) {
    try { await track.applyConstraints(constraints); }
    catch {
      try { await track.applyConstraints({
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      }); } catch {}
    }
  }
  try { if ("contentHint" in track) track.contentHint = "music"; } catch {}
  const settings = track.getSettings?.() ?? {};
  const summary = ["echoCancellation", "noiseSuppression", "autoGainControl"].map((key) => {
    const state = settings[key];
    return `${key} ${state === false ? "off" : state === true ? "on" : "unknown"}`;
  }).join(", ");
  return { settings, summary, confirmed: ["echoCancellation", "noiseSuppression", "autoGainControl"].every((key) => settings[key] === false) };
}
