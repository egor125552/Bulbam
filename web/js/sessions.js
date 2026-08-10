import { api } from "./api.js";
import {
  announce,
  elements,
  getCurrentAccount,
  getCurrentSession,
  showSignedOut
} from "./ui.js";

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
}

function renderSessions(sessions) {
  elements.sessionsRoot.replaceChildren();
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
  try {
    await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (isCurrent || sessionId === getCurrentSession()?.sessionId) {
      showSignedOut();
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
