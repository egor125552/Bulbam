// Swap WebRTC's track without rebuilding SDP, closing the call or dropping
// the previous microphone before Android/Safari grants a replacement.
export async function replaceCallCapture({ oldStream, sender, acquire, isCurrent, muted = false }) {
  const replacement = await acquire();
  const nextTrack = replacement.getAudioTracks()[0];
  if (!nextTrack || !isCurrent()) {
    replacement.getTracks().forEach((track) => track.stop());
    return { changed: false, stale: true };
  }
  nextTrack.enabled = !muted;
  try {
    await sender.replaceTrack(nextTrack);
  } catch (error) {
    replacement.getTracks().forEach((track) => track.stop());
    throw error;
  }
  if (!isCurrent()) {
    // The sender may now belong to the next selection; restore the prior
    // working audio track before stopping this stale capture.
    const previousTrack = oldStream?.getAudioTracks?.()[0];
    if (previousTrack?.readyState !== "ended") {
      try { await sender.replaceTrack(previousTrack); } catch {}
    }
    replacement.getTracks().forEach((track) => track.stop());
    return { changed: false, stale: true };
  }
  oldStream?.getTracks().forEach((track) => track.stop());
  return { changed: true, stream: replacement, track: nextTrack };
}
