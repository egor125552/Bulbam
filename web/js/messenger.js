import { api } from "./api.js";
import { announce, elements, getCurrentAccount } from "./ui.js";

let account = null;
let chats = [];
let selectedChat = null;
let messages = [];
let searchTimer = null;
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let heartbeatTimer = null;
let pollTimer = null;
let generation = 0;

export function setupMessenger() {
  elements.newChatButton.addEventListener("click", toggleSearchPanel);
  elements.userSearchInput.addEventListener("input", scheduleUserSearch);
  elements.userSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearchPanel();
  });
  elements.messageForm.addEventListener("submit", sendCurrentMessage);
  elements.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.messageForm.requestSubmit();
    }
  });

  window.addEventListener("bulbam:account-changed", (event) => {
    void switchAccount(event.detail?.account ?? null);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !account) return;
    void refreshVisibleState();
    if (!socket || socket.readyState > WebSocket.OPEN) connectRealtime();
  });
}

async function switchAccount(nextAccount) {
  generation += 1;
  account = nextAccount;
  chats = [];
  selectedChat = null;
  messages = [];
  stopRealtime();
  stopPolling();
  closeSearchPanel();
  renderChats();
  renderConversation();

  if (!account) return;
  const currentGeneration = generation;
  await loadChats({ quiet: true });
  if (generation !== currentGeneration) return;
  connectRealtime();
}

function toggleSearchPanel() {
  if (elements.userSearchPanel.hidden) {
    elements.userSearchPanel.hidden = false;
    elements.newChatButton.setAttribute("aria-expanded", "true");
    elements.userSearchInput.focus();
    return;
  }
  closeSearchPanel();
}

function closeSearchPanel() {
  clearTimeout(searchTimer);
  elements.userSearchPanel.hidden = true;
  elements.newChatButton.setAttribute("aria-expanded", "false");
  elements.userSearchInput.value = "";
  elements.userSearchResults.replaceChildren();
}

function scheduleUserSearch() {
  clearTimeout(searchTimer);
  const query = elements.userSearchInput.value.trim();
  if (query.length < 2) {
    elements.userSearchResults.replaceChildren();
    return;
  }
  searchTimer = setTimeout(() => void searchUsers(query), 250);
}

async function searchUsers(query) {
  try {
    const result = await api(`/api/v1/users/search?q=${encodeURIComponent(query)}`);
    if (elements.userSearchInput.value.trim() !== query) return;
    renderUserResults(result.users ?? []);
  } catch (error) {
    elements.userSearchResults.replaceChildren();
    announce(`Поиск не удался: ${error.message}`);
  }
}

function renderUserResults(users) {
  elements.userSearchResults.replaceChildren();
  if (!users.length) {
    const item = document.createElement("li");
    item.textContent = "Никого не найдено.";
    elements.userSearchResults.append(item);
    return;
  }

  for (const user of users) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "user-result";

    const name = document.createElement("strong");
    name.textContent = user.displayName;
    const username = document.createElement("span");
    username.textContent = `@${user.username}`;
    button.append(name, username);
    button.setAttribute("aria-label", `${user.displayName}, @${user.username}. Открыть чат`);
    button.addEventListener("click", () => void openDirectChat(user));
    item.append(button);
    elements.userSearchResults.append(item);
  }
}

async function openDirectChat(user) {
  try {
    announce(`Открываю чат с ${user.displayName}.`);
    const result = await api("/api/v1/chats/direct", {
      method: "POST",
      body: JSON.stringify({ userId: user.userId })
    });
    closeSearchPanel();
    await loadChats({ quiet: true });
    const chat = chats.find((candidate) => candidate.conversationId === result.chat.conversationId) ?? result.chat;
    await selectChat(chat, { focusHeading: true });
  } catch (error) {
    announce(`Не удалось открыть чат: ${error.message}`);
  }
}

async function loadChats({ quiet = false } = {}) {
  if (!account) return;
  try {
    const result = await api("/api/v1/chats");
    chats = result.chats ?? [];
    if (selectedChat) {
      selectedChat = chats.find((chat) => chat.conversationId === selectedChat.conversationId) ?? selectedChat;
    }
    renderChats();
  } catch (error) {
    if (!quiet) announce(`Не удалось загрузить чаты: ${error.message}`);
  }
}

function renderChats() {
  elements.chatList.replaceChildren();
  if (!account) return;

  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Пока нет диалогов. Нажми «Новый чат».";
    elements.chatList.append(empty);
    return;
  }

  for (const chat of chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-item";
    if (selectedChat?.conversationId === chat.conversationId) {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "page");
    }

    const name = document.createElement("strong");
    name.textContent = chat.peer.displayName;
    const username = document.createElement("span");
    username.className = "chat-username";
    username.textContent = `@${chat.peer.username}`;
    const preview = document.createElement("span");
    preview.className = "chat-preview";
    preview.textContent = chat.lastMessage ? oneLine(chat.lastMessage.text) : "Сообщений пока нет";
    button.append(name, username, preview);
    button.setAttribute(
      "aria-label",
      `${chat.peer.displayName}, @${chat.peer.username}. ${preview.textContent}`
    );
    button.addEventListener("click", () => void selectChat(chat, { focusHeading: true }));
    elements.chatList.append(button);
  }
}

async function selectChat(chat, { focusHeading = false } = {}) {
  selectedChat = chat;
  messages = [];
  renderChats();
  renderConversation();
  await loadMessages({ quiet: false });
  if (focusHeading) elements.conversationTitle.focus();
}

async function loadMessages({ quiet = false } = {}) {
  if (!account || !selectedChat) return;
  const conversationId = selectedChat.conversationId;
  try {
    const result = await api(`/api/v1/chats/${conversationId}/messages`);
    if (!selectedChat || selectedChat.conversationId !== conversationId) return;
    const serverMessages = result.messages ?? [];
    const pending = messages.filter((message) => message.localState);
    messages = serverMessages;
    for (const local of pending) {
      if (!messages.some((message) => message.clientMessageId === local.clientMessageId)) {
        messages.push(local);
      }
    }
    renderMessages();
    void acknowledgeIncomingMessages(conversationId, serverMessages);
  } catch (error) {
    if (!quiet) announce(`Не удалось загрузить сообщения: ${error.message}`);
  }
}

function renderConversation() {
  const chat = selectedChat;
  elements.messageList.replaceChildren();
  if (!account || !chat) {
    elements.conversationTitle.textContent = "Выберите чат";
    elements.conversationPeer.textContent = "Найди человека или открой существующий диалог.";
    elements.conversationEmpty.hidden = false;
    elements.messageForm.hidden = true;
    return;
  }

  elements.conversationTitle.textContent = chat.peer.displayName;
  elements.conversationPeer.textContent = `@${chat.peer.username}`;
  elements.conversationEmpty.hidden = true;
  elements.messageForm.hidden = false;
  renderMessages();
}

function renderMessages() {
  elements.messageList.replaceChildren();
  if (!selectedChat) return;

  if (!messages.length) {
    const item = document.createElement("li");
    item.className = "message-empty";
    item.textContent = "Сообщений пока нет. Напиши первым.";
    elements.messageList.append(item);
    return;
  }

  messages.sort((left, right) => left.createdAt - right.createdAt);
  for (const message of messages) {
    const item = document.createElement("li");
    const mine = message.senderUserId === account?.userId;
    item.className = `message ${mine ? "message-mine" : "message-theirs"}`;
    if (message.localState) item.classList.add(`message-${message.localState}`);

    const author = document.createElement("span");
    author.className = "message-author";
    author.textContent = mine ? "Вы" : selectedChat.peer.displayName;
    const body = document.createElement("p");
    body.textContent = message.text;
    const meta = document.createElement("span");
    meta.className = "message-meta";
    const state = message.localState === "pending"
      ? " · отправляется"
      : message.localState === "failed"
        ? " · не отправлено"
        : mine
          ? message.deliveredAt
            ? " · доставлено"
            : " · отправлено"
          : "";
    meta.textContent = `${formatTime(message.createdAt)}${state}`;
    item.append(author, body, meta);

    if (message.localState === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-message";
      retry.textContent = "Повторить отправку";
      retry.addEventListener("click", () => void transmitPending(message));
      item.append(retry);
    }

    elements.messageList.append(item);
  }
  elements.messageList.lastElementChild?.scrollIntoView({ block: "nearest" });
}

async function sendCurrentMessage(event) {
  event.preventDefault();
  if (!account || !selectedChat) return;
  const text = elements.messageInput.value.replace(/\r\n?/g, "\n").trim();
  if (!text) return;

  const pending = {
    messageId: `pending_${randomId()}`,
    conversationId: selectedChat.conversationId,
    senderUserId: account.userId,
    clientMessageId: randomId(),
    text,
    createdAt: Date.now(),
    deliveredAt: null,
    localState: "pending"
  };
  messages.push(pending);
  elements.messageInput.value = "";
  renderMessages();
  await transmitPending(pending);
}

async function transmitPending(pending) {
  if (!account || !selectedChat || pending.conversationId !== selectedChat.conversationId) return;
  pending.localState = "pending";
  renderMessages();
  try {
    const result = await api(`/api/v1/chats/${pending.conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        clientMessageId: pending.clientMessageId,
        text: pending.text
      })
    });
    upsertServerMessage(result.message);
    announce("Сообщение отправлено.");
    await loadChats({ quiet: true });
  } catch (error) {
    pending.localState = "failed";
    renderMessages();
    announce(`Сообщение не отправлено: ${error.message}. Можно повторить отправку.`);
  }
}

function upsertServerMessage(message) {
  const existing = messages.find(
    (candidate) => candidate.messageId === message.messageId || candidate.clientMessageId === message.clientMessageId
  );
  const merged = {
    ...(existing ?? {}),
    ...message,
    deliveredAt: message.deliveredAt ?? existing?.deliveredAt ?? null
  };
  delete merged.localState;
  messages = messages.filter(
    (candidate) => candidate.messageId !== message.messageId && candidate.clientMessageId !== message.clientMessageId
  );
  messages.push(merged);
  renderMessages();
}

async function acknowledgeIncomingMessages(conversationId, candidates) {
  if (!account) return;
  const accountId = account.userId;
  const currentGeneration = generation;
  const messageIds = [...new Set(
    candidates
      .filter((message) => message.senderUserId !== accountId && !message.deliveredAt)
      .map((message) => message.messageId)
  )];
  if (!messageIds.length) return;

  try {
    await api(`/api/v1/chats/${conversationId}/receipts/delivered`, {
      method: "POST",
      body: JSON.stringify({ messageIds })
    });
  } catch {
    if (generation !== currentGeneration || account?.userId !== accountId) return;
    setTimeout(() => {
      if (generation === currentGeneration && account?.userId === accountId) {
        void acknowledgeIncomingMessages(conversationId, candidates);
      }
    }, 2000);
  }
}

function connectRealtime() {
  if (!account || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/v1/realtime`);

  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    stopPolling();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25000);
  });

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (payload?.type === "message.created" && payload.message) {
      handleRealtimeMessage(payload);
    } else if (payload?.type === "messages.delivered" && Array.isArray(payload.receipts)) {
      handleDeliveredReceipts(payload);
    }
  });

  socket.addEventListener("close", handleRealtimeDisconnect);
  socket.addEventListener("error", () => {
    try { socket?.close(); } catch {}
  });
}

function handleRealtimeMessage(payload) {
  const chat = chats.find((candidate) => candidate.conversationId === payload.conversationId);
  if (selectedChat?.conversationId === payload.conversationId) {
    upsertServerMessage(payload.message);
  }
  void loadChats({ quiet: true });

  if (payload.message.senderUserId !== account?.userId) {
    void acknowledgeIncomingMessages(payload.conversationId, [payload.message]);
    announce(`Новое сообщение от ${chat?.peer?.displayName ?? "собеседника"}.`);
  }
}

function handleDeliveredReceipts(payload) {
  const receipts = payload.receipts ?? [];
  if (selectedChat?.conversationId === payload.conversationId) {
    let changed = false;
    for (const receipt of receipts) {
      const message = messages.find(
        (candidate) => candidate.messageId === receipt.messageId || candidate.clientMessageId === receipt.clientMessageId
      );
      if (!message) continue;
      const nextDeliveredAt = receipt.deliveredAt ?? message.deliveredAt;
      if (nextDeliveredAt && nextDeliveredAt !== message.deliveredAt) {
        message.deliveredAt = nextDeliveredAt;
        changed = true;
      }
    }
    if (changed) renderMessages();
  }

  const chat = chats.find((candidate) => candidate.conversationId === payload.conversationId);
  if (chat?.lastMessage) {
    const receipt = receipts.find(
      (candidate) => candidate.messageId === chat.lastMessage.messageId ||
        candidate.clientMessageId === chat.lastMessage.clientMessageId
    );
    if (receipt?.deliveredAt) chat.lastMessage.deliveredAt = receipt.deliveredAt;
  }
}

function handleRealtimeDisconnect() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  socket = null;
  if (!account) return;
  startPolling();
  clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(15000, reconnectDelay * 2);
  reconnectTimer = setTimeout(connectRealtime, delay);
}

function stopRealtime() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (socket) {
    try { socket.close(); } catch {}
  }
  socket = null;
}

function startPolling() {
  if (pollTimer || !account) return;
  pollTimer = setInterval(() => void refreshVisibleState(), 5000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshVisibleState() {
  await loadChats({ quiet: true });
  await loadMessages({ quiet: true });
}

function oneLine(value) {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ru", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `cm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// setupMessenger() is called before the initial account request; this keeps hot reload/manual imports sane.
account = getCurrentAccount();
