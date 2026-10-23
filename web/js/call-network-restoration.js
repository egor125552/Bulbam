// React to the moment internet access or the radio route changes. This runs
// independently of the 12-second initial-ICE watchdog, which remains a fallback
// when Safari emits no online/connectionchange event (e.g. some iOS handovers).
export function createCallNetworkRestoration(onRecover) {
  let wasOffline = false;
  let lastAttemptAt = -Infinity;
  return {
    offline() { wasOffline = true; },
    available(reason, { active, connected }, now = Date.now()) {
      if (!active) return false;
      const freshNetwork = wasOffline || reason === "online" || reason === "connection-change";
      if (!wasOffline && connected) return false;
      // Online and NetworkInformation events often fire together.
      // A confirmed offline->online transition can bypass a previous cooldown.
      if (!wasOffline && now - lastAttemptAt < 2500) return false;
      wasOffline = false;
      lastAttemptAt = now;
      onRecover({ reason: reason === "online" ? "browser-online" : reason, freshNetwork });
      return true;
    },
    reset() { wasOffline = false; lastAttemptAt = -Infinity; }
  };
}
