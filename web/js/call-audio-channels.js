export async function preferMonoCallCapture(track, profileId, baseConstraints = {}) {
  if (!track || profileId === "music" || typeof track.applyConstraints !== "function") return false;

  const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
  const channelCount = Number(settings?.channelCount);
  if (Number.isFinite(channelCount) && channelCount <= 1) return false;

  try {
    // Some WebKit devices keep a two-channel capture even when channelCount: { ideal: 1 }
    // was requested. If only the first hardware channel contains the microphone,
    // the remote side hears speech only in the left speaker. Strengthen the mono
    // requirement while preserving the rest of the selected microphone profile.
    await track.applyConstraints({ ...baseConstraints, channelCount: 1 });
    return true;
  } catch {
    // Do not make the whole call fail on hardware that cannot expose mono capture.
    return false;
  }
}
