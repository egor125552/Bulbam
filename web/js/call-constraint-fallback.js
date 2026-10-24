// Some mobile browsers reject multi-key live constraints even though they
// accept individual processing controls. Never discard a working audio track.
export async function applyCallConstraintsBestEffort(track, constraints) {
  if (typeof track?.applyConstraints !== "function") return { applied: false, reduced: true };
  try {
    await track.applyConstraints(constraints);
    return { applied: true, reduced: false };
  } catch (fullError) {
    const processing = Object.fromEntries(
      ["echoCancellation", "noiseSuppression", "autoGainControl"]
        .filter((key) => typeof constraints[key] === "boolean")
        .map((key) => [key, constraints[key]])
    );
    if (!Object.keys(processing).length) throw fullError;
    try {
      await track.applyConstraints(processing);
      return { applied: true, reduced: true };
    } catch (combinedError) {
      // Best effort must be honest: report success only when the browser
      // accepted at least one requested switch. Unsupported keys remain as-is.
      let accepted = 0;
      for (const [key, value] of Object.entries(processing)) {
        try {
          await track.applyConstraints({ [key]: value });
          accepted += 1;
        } catch {
          // Hardware/OS may lock a processing mode during active capture.
        }
      }
      if (accepted > 0) return { applied: true, reduced: true };
      throw combinedError;
    }
  }
}
