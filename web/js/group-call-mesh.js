// Pure helpers for multi-party WebRTC mesh group calls.
// Deterministic offer tie-breaking guarantees zero SDP glare between any pair
// of participants joining concurrently.

export function shouldInitiateOffer(localUserId, remoteUserId) {
  if (!localUserId || !remoteUserId || localUserId === remoteUserId) return false;
  return String(localUserId) < String(remoteUserId);
}

export function reconcileMeshPeers(localUserId, participants = [], existingPeerIds = []) {
  const existing = new Set(existingPeerIds);
  const remoteParticipants = (Array.isArray(participants) ? participants : []).filter(
    (entry) => entry && typeof entry.userId === "string" && entry.userId && entry.userId !== localUserId
  );
  const activeRemoteIds = new Set(remoteParticipants.map((entry) => entry.userId));

  const toConnect = [];
  for (const participant of remoteParticipants) {
    if (!existing.has(participant.userId)) {
      toConnect.push({
        userId: participant.userId,
        shouldOffer: shouldInitiateOffer(localUserId, participant.userId),
        participant
      });
    }
  }

  const toRemove = [];
  for (const peerId of existing) {
    if (!activeRemoteIds.has(peerId)) {
      toRemove.push(peerId);
    }
  }

  return { toConnect, toRemove };
}

export function formatParticipantCount(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} участника`;
  return `${n} участников`;
}

export function buildGroupCallBannerText(call) {
  const count = Number(call?.participantCount ?? call?.participants?.length ?? 0);
  if (count <= 0) return "Идёт групповой звонок";
  return `Идёт групповой звонок · ${formatParticipantCount(count)}`;
}

export function formatParticipantStatus({ displayName, muted = false, connectionState = "connected", isSelf = false }) {
  const name = isSelf ? `${displayName} (вы)` : displayName;
  if (isSelf) {
    return muted ? `${name} — микрофон выключен` : `${name} — микрофон включён`;
  }
  const linkLabel = connectionState === "connected"
    ? "на связи"
    : connectionState === "failed" || connectionState === "disconnected"
      ? "переподключается"
      : "соединяется";
  return muted ? `${name} — ${linkLabel}, микрофон выключен` : `${name} — ${linkLabel}`;
}
