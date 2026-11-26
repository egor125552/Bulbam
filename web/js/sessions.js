import { api } from "./api.js";
import { detachPushSubscription } from "./push.js";
import {
  announce,
  elements,
  getCurrentAccount,
  getCurrentSession,
  showSignedOut
} from "./ui.js";

function sessionBulkElements() {
  return {
    revokeOther: document.querySelector("#revoke-other-sessions"),
    revokeAllToggle: document.querySelector("#revoke-all-sessions"),
    confirmPanel: document.querySelector("#revoke-all-confirm"),
    confirmYes: document.querySelector("#revoke-all-confirm-yes"),
    confirmCancel: document.querySelector("#revoke-all-confirm-cancel")
  };
}

function closeRevokeAllConfirm({ returnFocus = false } = {}) {
  const { revokeAllToggle, confirmPanel } = sessionBulkElements();
  if (confirmPanel) confirmPanel.hidden = true;
  revokeAllToggle?.setAttribute("aria-expanded", "false");
  if (returnFocus) revokeAllToggle?.focus();
}

export async function loadSessions({ quiet = false } = {}) {
  if (!getCurrentAccount()) return;

  elements.refreshSessionsButton.disabled = true;
  try {
    const result = await api("/api/v1/sessions");
    renderSessions(result.sessions || []);
    if (!quiet) announce(`Активных сессий: ${result.sessions?.length || 0}.`);
  } catch (error) {
    announce(`Не удалось получить список сессий: ${error.message}`);
  } finally {
    elements.refreshSessionsButton.disabled = false;
  }
}

export function setupSessions() {
  elements.refreshSessionsButton.addEventListener("click", () => loadSessions());

  const { revokeOther, revokeAllToggle, confirmPanel, confirmYes, confirmCancel } = sessionBulkElements();

  revokeOther?.addEventListener("click", async () => {
    revokeOther.disabled = true;
    try {
      const result = await api("/api/v1/sessions/revoke-all", {
        method: "POST",
        body: JSON.stringify({ includeCurrent: false })
      });
      const count = Number(result?.revokedCount ?? 0);
      announce(
        count > 0
          ? `Остальные устройства отключены: ${count}.`
          : "Других активных устройств нет."
      );
      await loadSessions({ quiet: true });
    } catch (error) {
      announce(`Не удалось завершить остальные устройства: ${error.message}`);
      revokeOther.disabled = false;
    }
  });

  revokeAllToggle?.addEventListener("click", () => {
    if (!confirmPanel) return;
    const opening = confirmPanel.hidden;
    confirmPanel.hidden = !opening;
    revokeAllToggle.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) confirmYes?.focus();
  });

  confirmCancel?.addEventListener("click", () => {
    closeRevokeAllConfirm({ returnFocus: true });
  });

  confirmYes?.addEventListener("click", async () => {
    confirmYes.disabled = true;
    if (confirmCancel) confirmCancel.disabled = true;
    try {
      try {
        await detachPushSubscription();
      } catch {}
      await api("/api/v1/sessions/revoke-all", {
        method: "POST",
        body: JSON.stringify({ includeCurrent: true })
      });
      closeRevokeAllConfirm();
      showSignedOut();
      window.dispatchEvent(new CustomEvent("bulbam:show-auth-view", { detail: { view: "login" } }));
      announce("Вы вышли из аккаунта на всех устройствах.");
    } catch (error) {
      announce(`Не удалось выйти на всех устройствах: ${error.message}`);
    } finally {
      confirmYes.disabled = false;
      if (confirmCancel) confirmCancel.disabled = false;
    }
  });

  window.addEventListener("bulbam:account-changed", () => {
    if (!getCurrentAccount()) {
      closeRevokeAllConfirm();
      if (revokeOther) revokeOther.disabled = true;
    }
  });
}

function renderSessions(sessions) {
  elements.sessionsRoot.replaceChildren();
  const { revokeOther } = sessionBulkElements();
  const hasOtherSessions = sessions.some((session) => !session.isCurrent);
  if (revokeOther) revokeOther.disabled = !hasOtherSessions;

  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.textContent = "Активных сессий нет.";
    elements.sessionsRoot.append(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "session-list";
  for (const session of sessions) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = session.isCurrent ? `${session.deviceName} · текущая` : session.deviceName;

    const details = document.createElement("span");
    details.textContent = `Последняя активность: ${new Date(session.lastSeenAt).toLocaleString()}`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = session.isCurrent ? "Завершить текущую сессию" : "Завершить сессию";
    button.addEventListener("click", () => revokeSession(session.sessionId, session.isCurrent, button));

    item.append(title, details, button);
    list.append(item);
  }
  elements.sessionsRoot.append(list);
}

async function revokeSession(sessionId, isCurrent, button) {
  button.disabled = true;
  const revokingCurrent = isCurrent || sessionId === getCurrentSession()?.sessionId;
  try {
    if (revokingCurrent) {
      try {
        await detachPushSubscription();
      } catch {}
    }
    await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (revokingCurrent) {
      closeRevokeAllConfirm();
      showSignedOut();
      window.dispatchEvent(new CustomEvent("bulbam:show-auth-view", { detail: { view: "login" } }));
      announce("Текущая сессия завершена.");
      return;
    }
    announce("Сессия устройства завершена.");
    await loadSessions({ quiet: true });
  } catch (error) {
    announce(`Не удалось завершить сессию: ${error.message}`);
    button.disabled = false;
  }
}
