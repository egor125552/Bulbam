// Pure state & label helpers for the group call participant picker dialog.
// Guarantees the "Позвонить" button is only enabled/visible when at least
// one participant is selected, and cleanly absent when selection is empty.

import { formatParticipantCount } from "./group-call-mesh.js";

export function normalizeCallCandidates(members = [], selfUserId = null) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(members) ? members : []) {
    if (!raw || typeof raw !== "object") continue;
    const user = raw.user && typeof raw.user === "object" ? raw.user : raw;
    const userId = String(raw.userId || user.userId || "").trim();
    if (!userId || userId === selfUserId || seen.has(userId)) continue;
    seen.add(userId);
    result.push({
      userId,
      username: String(user.username || "").trim(),
      displayName: String(user.displayName || user.username || "Участник").trim()
    });
  }
  return result;
}

export function createGroupCallPickerState(members = [], selfUserId = null) {
  let candidates = normalizeCallCandidates(members, selfUserId);
  const selected = new Set();

  function snapshot() {
    const selectedIds = candidates
      .filter((member) => selected.has(member.userId))
      .map((member) => member.userId);
    const selectedCount = selectedIds.length;
    return {
      candidates: [...candidates],
      selectedIds,
      selectedCount,
      canCall: selectedCount > 0,
      allSelected: candidates.length > 0 && selectedCount === candidates.length
    };
  }

  return {
    setMembers(nextMembers) {
      candidates = normalizeCallCandidates(nextMembers, selfUserId);
      const validIds = new Set(candidates.map((member) => member.userId));
      for (const id of [...selected]) {
        if (!validIds.has(id)) selected.delete(id);
      }
      return snapshot();
    },
    toggle(userId) {
      if (!candidates.some((member) => member.userId === userId)) return snapshot();
      if (selected.has(userId)) selected.delete(userId);
      else selected.add(userId);
      return snapshot();
    },
    selectAll() {
      for (const member of candidates) selected.add(member.userId);
      return snapshot();
    },
    clear() {
      selected.clear();
      return snapshot();
    },
    toggleAll() {
      if (candidates.length > 0 && selected.size === candidates.length) {
        selected.clear();
      } else {
        for (const member of candidates) selected.add(member.userId);
      }
      return snapshot();
    },
    isSelected(userId) {
      return selected.has(userId);
    },
    snapshot
  };
}

export function formatCallPickerCount(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return "Никто не выбран";
  return `Выбрано: ${formatParticipantCount(n)}`;
}

export function formatCallPickerSubmitLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return "Позвонить";
  return `Позвонить (${n})`;
}
