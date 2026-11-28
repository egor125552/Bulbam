import { api } from "./api.js";
import { language, translateText } from "./i18n.js";
import { announce, getCurrentAccount } from "./ui.js";

let refreshing = false;
let refreshQueued = false;
let lastRefreshCompletedAt = 0;
let lastUsers = [];

function isOwnerAccount() {
  return getCurrentAccount()?.role === "owner";
}

function roleLabel(role) {
  if (role === "owner") return translateText("Владелец");
  if (role === "admin") return translateText("Администратор");
  return translateText("Участник");
}

function formatTimestamp(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return "";
  try {
    return new Date(Number(ms)).toLocaleString(language() === "be" ? "be-BY" : "ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return new Date(Number(ms)).toLocaleString();
  }
}

function buildStatusLine(user) {
  const parts = [];
  if (user.online) {
    parts.push(translateText("В сети"));
  } else if (user.lastActiveAt) {
    parts.push(`${translateText("Не в сети")} · ${translateText("был(а)")} ${formatTimestamp(user.lastActiveAt)}`);
  } else {
    parts.push(translateText("Не в сети"));
  }

  if (user.activeSessionsCount > 0) {
    parts.push(`${translateText("Активных сеансов")}: ${user.activeSessionsCount}`);
  } else if (user.restorableSessionsCount > 0) {
    parts.push(translateText("Сеанс истёк или завершён (можно восстановить)"));
  } else {
    parts.push(translateText("Нет сохранённых сеансов"));
  }

  if (user.lastDeviceName) {
    parts.push(`${translateText("Устройство")}: ${user.lastDeviceName}`);
  }
  return parts.join(" · ");
}

function setStatusText(text, { speak = false, focus = false } = {}) {
  const status = document.querySelector("#owner-control-status");
  const translated = translateText(text);
  if (status) {
    status.textContent = translated;
    if (focus) status.focus({ preventScroll: true });
  }
  if (speak) announce(text);
}

function updateCardStatus(li, user) {
  li.dataset.online = user.online ? "true" : "false";
  const statusEl = li.querySelector(".owner-user-status");
  if (statusEl) statusEl.textContent = buildStatusLine(user);
  const badge = li.querySelector(".owner-presence-badge");
  if (badge) {
    badge.textContent = user.online ? translateText("В сети") : translateText("Не в сети");
    badge.dataset.online = user.online ? "true" : "false";
  }
  const restoreButton = li.querySelector('[data-owner-action="restore"]');
  if (restoreButton) restoreButton.disabled = !user.canRestoreSession;
  const revokeButton = li.querySelector('[data-owner-action="revoke"]');
  if (revokeButton) revokeButton.disabled = user.activeSessionsCount === 0;
}

function createUserCard(user) {
  const li = document.createElement("li");
  li.className = "owner-user-card";
  li.dataset.userId = user.userId;
  li.dataset.online = user.online ? "true" : "false";

  const header = document.createElement("div");
  header.className = "owner-user-header";

  const heading = document.createElement("h4");
  heading.className = "owner-user-name";
  heading.dataset.userContent = "true";
  const nameId = `owner-user-${user.userId}`;
  heading.id = nameId;
  heading.textContent = `${user.displayName} (@${user.username})`;

  const metaTag = document.createElement("span");
  metaTag.className = "owner-role-tag";
  metaTag.textContent = user.isSelf
    ? `${roleLabel(user.role)} · ${translateText("вы")}`
    : roleLabel(user.role);

  const badge = document.createElement("span");
  badge.className = "owner-presence-badge";
  badge.dataset.online = user.online ? "true" : "false";
  badge.textContent = user.online ? translateText("В сети") : translateText("Не в сети");

  header.append(heading, metaTag, badge);
  li.setAttribute("aria-labelledby", nameId);

  const statusLine = document.createElement("p");
  statusLine.className = "owner-user-status";
  statusLine.textContent = buildStatusLine(user);

  li.append(header, statusLine);

  if (user.isSelf || user.role === "owner") {
    return li;
  }

  const actions = document.createElement("div");
  actions.className = "owner-user-actions";

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.dataset.ownerAction = "restore";
  restoreButton.textContent = translateText("Вернуть в аккаунт (восстановить сеанс)");
  restoreButton.disabled = !user.canRestoreSession;

  const linkButton = document.createElement("button");
  linkButton.type = "button";
  linkButton.dataset.ownerAction = "login-link";
  linkButton.textContent = translateText("Одноразовая ссылка входа");

  const revokeButton = document.createElement("button");
  revokeButton.type = "button";
  revokeButton.dataset.ownerAction = "revoke";
  revokeButton.textContent = translateText("Завершить все сеансы");
  revokeButton.disabled = user.activeSessionsCount === 0;

  const deleteToggle = document.createElement("button");
  deleteToggle.type = "button";
  deleteToggle.className = "danger-button";
  deleteToggle.dataset.ownerAction = "delete-toggle";
  deleteToggle.setAttribute("aria-expanded", "false");
  deleteToggle.textContent = translateText("Удалить аккаунт…");

  actions.append(restoreButton, linkButton, revokeButton, deleteToggle);

  const linkBox = document.createElement("div");
  linkBox.className = "owner-link-box";
  linkBox.hidden = true;

  const linkLabel = document.createElement("label");
  const linkInputId = `owner-link-input-${user.userId}`;
  linkLabel.setAttribute("for", linkInputId);
  linkLabel.textContent = translateText("Одноразовая ссылка входа (действует 10 минут)");

  const linkInput = document.createElement("input");
  linkInput.id = linkInputId;
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.spellcheck = false;

  const copyLinkButton = document.createElement("button");
  copyLinkButton.type = "button";
  copyLinkButton.textContent = translateText("Скопировать ссылку");

  copyLinkButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      setStatusText("Одноразовая ссылка скопирована.", { speak: true });
    } catch {
      linkInput.select();
      setStatusText("Ссылка выделена. Скопируйте её стандартной командой.", { speak: true });
    }
  });

  linkBox.append(linkLabel, linkInput, copyLinkButton);

  const deletePanel = document.createElement("div");
  deletePanel.className = "owner-delete-panel";
  deletePanel.hidden = true;

  const reasonLabel = document.createElement("label");
  const reasonId = `owner-delete-reason-${user.userId}`;
  reasonLabel.setAttribute("for", reasonId);
  reasonLabel.textContent = translateText("Причина удаления (увидит пользователь)");

  const reasonInput = document.createElement("input");
  reasonInput.id = reasonId;
  reasonInput.type = "text";
  reasonInput.maxLength = 240;
  reasonInput.placeholder = translateText("Например: нарушение правил или по просьбе владельца");

  const confirmLabel = document.createElement("label");
  confirmLabel.className = "owner-delete-confirm-label";
  const confirmCheckbox = document.createElement("input");
  confirmCheckbox.type = "checkbox";
  confirmLabel.append(
    confirmCheckbox,
    ` ${translateText("Я точно уверен, что хочу удалить этого пользователя и все его переписки навсегда.")}`
  );

  const deleteControls = document.createElement("div");
  deleteControls.className = "owner-delete-controls";

  const confirmDeleteButton = document.createElement("button");
  confirmDeleteButton.type = "button";
  confirmDeleteButton.className = "danger-button";
  confirmDeleteButton.textContent = translateText("Удалить навсегда");

  const cancelDeleteButton = document.createElement("button");
  cancelDeleteButton.type = "button";
  cancelDeleteButton.textContent = translateText("Отмена");

  deleteControls.append(confirmDeleteButton, cancelDeleteButton);
  deletePanel.append(reasonLabel, reasonInput, confirmLabel, deleteControls);

  restoreButton.addEventListener("click", async () => {
    restoreButton.disabled = true;
    setStatusText("Восстанавливаю сеанс пользователя…");
    try {
      const result = await api(`/api/v1/owner/users/${encodeURIComponent(user.userId)}/restore-session`, {
        method: "POST"
      });
      if (result.restored) {
        const msg = `${translateText("Сеанс восстановлен на 90 дней")}: @${user.username}. ${translateText("Пользователь может обновить страницу и вернуться в аккаунт без пароля.")}`;
        setStatusText(msg, { speak: true, focus: true });
      } else {
        setStatusText("У этого пользователя нет прежнего сеанса. Выдайте одноразовую ссылку входа.", {
          speak: true,
          focus: true
        });
      }
      await refreshOwnerUsers();
    } catch (error) {
      setStatusText(`${translateText("Не удалось восстановить сеанс")}: ${error.message}`, { speak: true });
      restoreButton.disabled = false;
    }
  });

  linkButton.addEventListener("click", async () => {
    linkButton.disabled = true;
    setStatusText("Создаю одноразовую ссылку входа…");
    try {
      const result = await api(`/api/v1/owner/users/${encodeURIComponent(user.userId)}/login-link`, {
        method: "POST"
      });
      linkInput.value = result.loginUrl;
      linkBox.hidden = false;
      let copied = false;
      try {
        await navigator.clipboard.writeText(result.loginUrl);
        copied = true;
      } catch {}
      setStatusText(
        copied
          ? `${translateText("Одноразовая ссылка входа создана и скопирована для")} @${user.username}.`
          : `${translateText("Одноразовая ссылка входа создана для")} @${user.username}.`,
        { speak: true }
      );
      linkInput.focus();
    } catch (error) {
      setStatusText(`${translateText("Не удалось создать ссылку входа")}: ${error.message}`, { speak: true });
    } finally {
      linkButton.disabled = false;
    }
  });

  revokeButton.addEventListener("click", async () => {
    revokeButton.disabled = true;
    setStatusText("Завершаю сеансы пользователя…");
    try {
      await api(`/api/v1/owner/users/${encodeURIComponent(user.userId)}/revoke-sessions`, {
        method: "POST"
      });
      setStatusText(`${translateText("Все сеансы пользователя завершены")}: @${user.username}.`, {
        speak: true,
        focus: true
      });
      await refreshOwnerUsers();
    } catch (error) {
      setStatusText(`${translateText("Не удалось завершить сеансы")}: ${error.message}`, { speak: true });
      revokeButton.disabled = false;
    }
  });

  deleteToggle.addEventListener("click", () => {
    const opening = deletePanel.hidden;
    deletePanel.hidden = !opening;
    deleteToggle.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) {
      confirmCheckbox.checked = false;
      reasonInput.focus();
    }
  });

  cancelDeleteButton.addEventListener("click", () => {
    deletePanel.hidden = true;
    deleteToggle.setAttribute("aria-expanded", "false");
    confirmCheckbox.checked = false;
    deleteToggle.focus();
  });

  confirmDeleteButton.addEventListener("click", async () => {
    if (!confirmCheckbox.checked) {
      announce("Сначала поставьте флажок подтверждения, что вы точно уверены в удалении.");
      confirmCheckbox.focus();
      return;
    }
    confirmDeleteButton.disabled = true;
    cancelDeleteButton.disabled = true;
    setStatusText("Удаляю аккаунт и переписки…");
    try {
      const result = await api(`/api/v1/owner/users/${encodeURIComponent(user.userId)}`, {
        method: "DELETE",
        body: JSON.stringify({
          confirmed: true,
          reason: reasonInput.value.trim()
        })
      });
      li.remove();
      await refreshOwnerUsers();
      setStatusText(
        `${translateText("Аккаунт полностью удалён")}: @${result.username}.`,
        { speak: true, focus: true }
      );
    } catch (error) {
      setStatusText(`${translateText("Не удалось удалить аккаунт")}: ${error.message}`, { speak: true });
      confirmDeleteButton.disabled = false;
      cancelDeleteButton.disabled = false;
    }
  });

  li.append(actions, linkBox, deletePanel);
  return li;
}

function renderOwnerUsers(users) {
  const list = document.querySelector("#owner-users-list");
  if (!list) return;
  const existing = new Map([...list.children].map((item) => [item.dataset.userId, item]));
  const currentIds = new Set(users.map((user) => user.userId));

  for (const [id, item] of existing) {
    if (!currentIds.has(id)) item.remove();
  }

  for (const user of users) {
    const existingCard = existing.get(user.userId);
    if (existingCard) {
      updateCardStatus(existingCard, user);
    } else {
      list.append(createUserCard(user));
    }
  }
}

export async function refreshOwnerUsers({ announceSummary = false, fromRealtime = false } = {}) {
  const panel = document.querySelector("#owner-control-panel");
  const authorized = isOwnerAccount();
  if (panel) panel.hidden = !authorized;
  if (!authorized) return;

  if (fromRealtime && (refreshing || Date.now() - lastRefreshCompletedAt < 1500)) {
    return;
  }

  if (refreshing) {
    refreshQueued = true;
    return;
  }

  refreshing = true;
  refreshQueued = false;
  try {
    const result = await api("/api/v1/owner/users");
    const users = Array.isArray(result.users) ? result.users : [];
    lastUsers = users;
    lastRefreshCompletedAt = Date.now();
    renderOwnerUsers(users);
    const onlineCount = users.filter((u) => u.online).length;
    const summary = `${translateText("Пользователей")}: ${users.length} · ${translateText("в сети")}: ${onlineCount}.`;
    const status = document.querySelector("#owner-control-status");
    if (status && (!status.textContent || announceSummary)) {
      status.textContent = summary;
    }
    if (announceSummary) announce(summary);
  } catch (error) {
    setStatusText(`${translateText("Не удалось загрузить пользователей")}: ${error.message}`, {
      speak: announceSummary
    });
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshOwnerUsers();
    }
  }
}

export function setupOwnerControl() {
  document.querySelector("#owner-users-refresh")?.addEventListener("click", () => {
    void refreshOwnerUsers({ announceSummary: true });
  });

  window.addEventListener("bulbam:account-changed", () => {
    const panel = document.querySelector("#owner-control-panel");
    const authorized = isOwnerAccount();
    if (panel) panel.hidden = !authorized;
    if (authorized) {
      void refreshOwnerUsers();
    } else {
      lastUsers = [];
      lastRefreshCompletedAt = 0;
      document.querySelector("#owner-users-list")?.replaceChildren();
    }
  });

  window.addEventListener("bulbam:owner-users-updated", () => {
    if (isOwnerAccount()) void refreshOwnerUsers({ fromRealtime: true });
  });

  window.addEventListener("bulbam:language-changed", () => {
    if (!isOwnerAccount()) return;
    const list = document.querySelector("#owner-users-list");
    if (list) {
      list.replaceChildren();
      renderOwnerUsers(lastUsers);
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.('[data-open-settings="diagnostics"]');
    if (button && isOwnerAccount()) void refreshOwnerUsers();
  });

  const isCallActive = () =>
    typeof document !== "undefined" && document.documentElement?.dataset?.bulbamCallActive === "true";

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isOwnerAccount() && !isCallActive()) {
      const panel = document.querySelector("#owner-control-panel");
      if (panel && !panel.hidden) void refreshOwnerUsers();
    }
  });

  setInterval(() => {
    if (!isOwnerAccount() || isCallActive()) return;
    const dialog = document.querySelector("#settings-dialog");
    const screen = document.querySelector('[data-settings-screen="diagnostics"]');
    if (dialog?.open && screen && !screen.hidden) {
      void refreshOwnerUsers();
    }
  }, 20000);
}
