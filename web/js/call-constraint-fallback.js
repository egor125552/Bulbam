// A browser may reject a full audio profile because it cannot switch channel
// count or sample rate during a live call. Retry only the voice-processing
// toggles instead of failing all profile controls and discarding live audio.
export async function applyCallConstraintsBestEffort(track, constraints) {
  if (typeof track?.applyConstraints !== "function") return { applied: false, reduced: true };
  try {
    await track.applyConstraints(constraints);
    return { applied: true, reduced: false };
  } catch (error) {
    const processing = Object.fromEntries(
      ["echoCancellation", "noiseSuppression", "autoGainControl"]
        .filter((key) => typeof constraints[key] === "boolean")
        .map((key) => [key, constraints[key]])
    );
    if (Object.keys(processing).length === 0) throw error;
    await track.applyConstraints(processing);
    return { applied: true, reduced: true };
  }
}
