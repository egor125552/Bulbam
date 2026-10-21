import { translateText } from "./i18n.js";
import { api } from "./api.js";
import { chatAccessibleLabel, chatPreview, chatTimeLabel, dayKey, dayLabel, isNearBottom, messageDeliveryState, messageTime } from "./chat-presentation.js";
import { announce, elements, getCurrentAccount } from "./ui.js";
import {
  applyRemoteVoiceProgress,
  captureVoicePlaybackState,
  renderVoiceMessage,
  resetVoicePlayers,
  restoreVoicePlaybackState,
  setVoiceMessageSequence
} from "./voice-player.js";

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
let jumpButton = null;
let presenceByUserId = new Map();

export function setupMessenger() {
  jumpButton = document.querySelector("#jump-to-latest");
  jumpButton?.addEventListener("click", jumpToLatest);
  elements.messageList.addEventListener("scroll", () => {
    if (jumpButton && isNearBottom(elements.messageList)) jumpButton.hidden = true;
  });
  elements.newChatButton.addEventListener("click", toggleSearchPanel);
  elements.userSearchInput.addEventListener("input", scheduleUserSearch);
  elements.userSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearchPanel({ restoreFocus: true });
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
  window.addEventListener("bulbam:presence-updated", event => {
    presenceByUserId = new Map((event.detail?.users ?? []).map(user=>[user.userId,user]));
    updatePeerPresence();
  });
  window.addEventListener("bulbam:language-changed", () => {
    if(!account)return;
    // Regenerate dates, accessible chat previews and delivery statuses without
    // translating user-generated messages. Preserve audio and keyboard focus.
    renderChats();
    if(selectedChat)renderMessages({preserveVoicePlayback:true});
    else renderConversation();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !account) return;
    void refreshVisibleState();
    if (!socket || socket.readyState > WebSocket.OPEN) connectRealtime();
  });
}

export function getSelectedChat() {
  return selectedChat;
}

export function acceptExternalMessage(message) {
  if (!message || message.conversationId !== selectedChat?.conversationId) return;
  upsertServerMessage(message);
}

export async function refreshChatsAfterExternalMessage() {
  await loadChats({ quiet: true });
}

async function switchAccount(nextAccount) {
  generation += 1;
  account = nextAccount;
  chats = [];
  presenceByUserId.clear();
  selectedChat = null;
  messages = [];
  resetVoicePlayers();
  stopRealtime();
  stopPolling();
  closeSearchPanel();
  renderChats();
  renderConversation();
  if (jumpButton) jumpButton.hidden = true;
  window.dispatchEvent(new CustomEvent("bulbam:chat-changed", { detail: { chat: null } }));

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
  closeSearchPanel({ restoreFocus: true });
}

function closeSearchPanel({ restoreFocus = false } = {}) {
  clearTimeout(searchTimer);
  elements.userSearchPanel.hidden = true;
  elements.newChatButton.setAttribute("aria-expanded", "false");
  elements.userSearchInput.value = "";
  elements.userSearchResults.replaceChildren();
  if (restoreFocus) elements.newChatButton.focus();
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
    item.textContent = translateText("Никого не найдено.");
    elements.userSearchResults.append(item);
    return;
  }

  for (const user of users) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "user-result";

    const name = document.createElement("strong");
    name.dataset.userContent = "true";
    name.textContent = user.displayName;
    const username = document.createElement("span");
    username.dataset.userContent = "true";
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
  const focusedChatId = document.activeElement?.closest?.(".chat-item")?.dataset.conversationId;
  elements.chatList.replaceChildren();
  if (!account) return;

  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = translateText("Здесь будут ваши переписки. Нажмите «Новый чат», чтобы найти человека.");
    elements.chatList.append(empty);
    return;
  }

  for (const chat of chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-item";
    button.dataset.conversationId = chat.conversationId;
    if (selectedChat?.conversationId === chat.conversationId) {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "page");
    }

    const name = document.createElement("strong");
    name.dataset.userContent = "true";
    name.textContent = chat.peer.displayName;
    const username = document.createElement("span");
    username.className = "chat-username";
    username.dataset.userContent = "true";
    username.textContent = `@${chat.peer.username}`;

    const preview = document.createElement("span");
    preview.className = "chat-preview";
    preview.dataset.userContent = "true";
    const deliveryState = messageDeliveryState(chat.lastMessage, account.userId);
    preview.textContent = [chatPreview(chat.lastMessage, account.userId), deliveryState].filter(Boolean).join(" · ");

    const time = document.createElement("time");
    time.className = "chat-time";
    const lastMessageAt = chat.lastMessage?.createdAt ?? chat.lastMessageAt;
    time.textContent = lastMessageAt ? chatTimeLabel(lastMessageAt) : "";
    time.hidden = !time.textContent;
    if (lastMessageAt && Number.isFinite(new Date(lastMessageAt).getTime())) {
      time.dateTime = new Date(lastMessageAt).toISOString();
    }

    const presence=document.createElement("span");
    presence.className="chat-presence";
    presence.dataset.presenceUserId=chat.peer.userId;
    presence.textContent=presenceLabel(chat.peer.userId);
    button.append(name, time, username, presence, preview);
    button.setAttribute("aria-label", peerChatLabel(chat));
    button.addEventListener("click", () => void selectChat(chat, { focusHeading: true }));
    elements.chatList.append(button);
  }
  if (focusedChatId) {
    const restored = [...elements.chatList.querySelectorAll(".chat-item")]
      .find((button) => button.dataset.conversationId === focusedChatId);
    restored?.focus({ preventScroll: true });
  }
}

async function selectChat(chat, { focusHeading = false } = {}) {
  selectedChat = chat;
  if (jumpButton) jumpButton.hidden = true;
  messages = [];
  resetVoicePlayers();
  renderChats();
  renderConversation();
  window.dispatchEvent(new CustomEvent("bulbam:chat-changed", { detail: { chat } }));
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
    renderMessages({ preserveVoicePlayback: true });
    void acknowledgeIncomingMessages(conversationId, serverMessages);
  } catch (error) {
    if (!quiet) announce(`Не удалось загрузить сообщения: ${error.message}`);
  }
}

function renderConversation() {
  const chat = selectedChat;
  resetVoicePlayers();
  elements.messageList.replaceChildren();
  if (!account || !chat) {
    elements.conversationTitle.textContent = translateText("Выберите чат");
    elements.conversationPeer.textContent = translateText("Найди человека или открой существующий диалог.");
    elements.conversationEmpty.hidden = false;
    elements.messageForm.hidden = true;
    delete elements.messageForm.dataset.conversationId;
    return;
  }

  elements.messageForm.dataset.conversationId = chat.conversationId;
  elements.conversationTitle.textContent = chat.peer.displayName;
  elements.conversationPeer.textContent = `@${chat.peer.username} · ${presenceLabel(chat.peer.userId)}`;
  elements.conversationEmpty.hidden = true;
  elements.messageForm.hidden = false;
  renderMessages();
}

function presenceLabel(userId) {
  return presenceByUserId.get(userId)?.label ?? translateText("Статус неизвестен");
}

function peerChatLabel(chat) {
  return chatAccessibleLabel(chat, account?.userId) + ". " + presenceLabel(chat.peer.userId);
}

function updatePeerPresence() {
  if (!account)return;
  for (const chat of chats) {
    const button=[...elements.chatList.querySelectorAll(".chat-item")]
      .find(element=>element.dataset.conversationId===chat.conversationId);
    if (!button)continue;
    const span=button.querySelector(".chat-presence");
    if(span)span.textContent=presenceLabel(chat.peer.userId);
    button.setAttribute("aria-label",peerChatLabel(chat));
  }
  if(selectedChat)
    elements.conversationPeer.textContent=`@${selectedChat.peer.username} · ${presenceLabel(selectedChat.peer.userId)}`;
}

function renderMessages({ preserveVoicePlayback = false, scrollToBottom = false } = {}) {
  const list = elements.messageList;
  const wasNearBottom = isNearBottom(list);
  const oldScrollTop = list.scrollTop;
  const previousIds = new Set([...list.querySelectorAll(".message[data-message-id]")]
    .map((item) => item.dataset.messageId));
  const playbackState = preserveVoicePlayback ? captureVoicePlaybackState() : [];
  const focusState = preserveVoicePlayback ? captureMessageFocus() : null;
  resetVoicePlayers();
  list.replaceChildren();
  if (!selectedChat) return;

  if (!messages.length) {
    const item = document.createElement("li");
    item.className = "message-empty";
    item.textContent = translateText("Здесь пока нет сообщений. Напишите что-нибудь или запишите голосовое.");
    list.append(item);
    if (jumpButton) jumpButton.hidden = true;
    return;
  }

  messages.sort((left, right) => left.createdAt - right.createdAt);
  let lastDay = "";
  for (const message of messages) {
    const currentDay = dayKey(message.createdAt);
    if (currentDay !== lastDay) {
      const separator = document.createElement("li");
      separator.className = "message-day";
      separator.setAttribute("role", "separator");
      separator.setAttribute("aria-label", dayLabel(message.createdAt));
      separator.textContent = dayLabel(message.createdAt);
      list.append(separator);
      lastDay = currentDay;
    }

    const item = document.createElement("li");
    const mine = message.senderUserId === account?.userId;
    item.className = `message ${mine ? "message-mine" : "message-theirs"}`;
    item.dataset.messageId = message.messageId;
    if (message.localState) item.classList.add(`message-${message.localState}`);

    const author = document.createElement("span");
    author.className = "message-author";
    author.textContent = mine ? "Вы" : selectedChat.peer.displayName;
    item.append(author);

    if (message.kind === "voice" && message.voice) {
      item.append(renderVoiceMessage(message, mine));
    } else {
      const body = document.createElement("p");
      body.dataset.userContent = "true";
      body.textContent = message.text;
      item.append(body);
    }

    const meta = document.createElement("span");
    meta.className = "message-meta";
    const time = document.createElement("time");
    const validDate = new Date(message.createdAt);
    if (Number.isFinite(validDate.getTime())) time.dateTime = validDate.toISOString();
    time.textContent = messageTime(message.createdAt);
    meta.append(time);

    const state = message.localState === "pending"
      ? "отправляется"
      : message.localState === "failed"
        ? "не отправлено"
        : mine
          ? message.readAt ? "прочитано" : message.deliveredAt ? "доставлено" : "отправлено"
          : "";
    if (state) {
      const stateLabel = document.createElement("span");
      stateLabel.textContent = ` · ${translateText(state)}`;
      meta.append(stateLabel);
    }
    item.append(meta);

    if (message.localState === "failed" && message.kind !== "voice") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-message";
      retry.textContent = translateText("Повторить отправку");
      retry.addEventListener("click", () => void transmitPending(message));
      item.append(retry);
    }

    list.append(item);
  }

  setVoiceMessageSequence(messages);
  const stickToBottom = scrollToBottom || !preserveVoicePlayback || wasNearBottom;
  if (stickToBottom) {
    list.scrollTop = list.scrollHeight;
    if (jumpButton) jumpButton.hidden = true;
  } else {
    list.scrollTop = oldScrollTop;
    const newMessage = messages.some((message) => !previousIds.has(message.messageId) &&
      message.senderUserId !== account?.userId && !message.localState);
    if (newMessage && jumpButton) jumpButton.hidden = false;
  }
  if (playbackState.length) void restoreVoicePlaybackState(playbackState);
  if (focusState) restoreMessageFocus(focusState);
}

function jumpToLatest() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
  if (jumpButton) jumpButton.hidden = true;
  const latest = elements.messageList.querySelector(".message:last-child");
  if (latest) {
    latest.tabIndex = -1;
    latest.focus({ preventScroll: true });
  }
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
    kind: "text",
    text,
    voice: null,
    createdAt: Date.now(),
    deliveredAt: null,
    localState: "pending"
  };
  messages.push(pending);
  elements.messageInput.value = "";
  renderMessages({ preserveVoicePlayback: true, scrollToBottom: true });
  await transmitPending(pending);
}

async function transmitPending(pending) {
  if (!account || !selectedChat || pending.conversationId !== selectedChat.conversationId) return;
  pending.localState = "pending";
  renderMessages({ preserveVoicePlayback: true });
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
    renderMessages({ preserveVoicePlayback: true });
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
    deliveredAt: message.deliveredAt ?? existing?.deliveredAt ?? null,
    readAt: message.readAt ?? existing?.readAt ?? null
  };
  delete merged.localState;
  messages = messages.filter(
    (candidate) => candidate.messageId !== message.messageId && candidate.clientMessageId !== message.clientMessageId
  );
  messages.push(merged);
  renderMessages({ preserveVoicePlayback: true });
}

async function acknowledgeIncomingMessages(conversationId, candidates) {
  if (!account) return;
  const accountId = account.userId;
  const currentGeneration = generation;
  const incoming = candidates.filter((message) => message.senderUserId !== accountId);
  const isOpenAndVisible = selectedChat?.conversationId === conversationId && document.visibilityState === "visible";
  const readIds = isOpenAndVisible ? [...new Set(incoming.filter((message) => !message.readAt).map((message) => message.messageId))] : [];
  const deliveredIds = [...new Set(incoming.filter((message) => !message.deliveredAt && !readIds.includes(message.messageId)).map((message) => message.messageId))];
  try {
    if (deliveredIds.length) {
      await api(`/api/v1/chats/${conversationId}/receipts/delivered`, { method: "POST", body: JSON.stringify({ messageIds: deliveredIds }) });
    }
    if (readIds.length) {
      await api(`/api/v1/chats/${conversationId}/receipts/read`, { method: "POST", body: JSON.stringify({ messageIds: readIds }) });
    }
  } catch {
    if (generation !== currentGeneration || account?.userId !== accountId) return;
    setTimeout(() => { if (generation === currentGeneration && account?.userId === accountId) void acknowledgeIncomingMessages(conversationId, candidates); }, 2000);
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
    } else if ((payload?.type === "messages.delivered" || payload?.type === "messages.read") && Array.isArray(payload.receipts)) {
      handleDeliveredReceipts(payload);
    } else if (payload?.type === "voice.progress" && payload.messageId && payload.progress) {
      handleVoiceProgress(payload);
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

function handleVoiceProgress(payload) {
  if (selectedChat?.conversationId !== payload.conversationId) return;
  const message = messages.find((candidate) => candidate.messageId === payload.messageId);
  if (message?.voice) message.voice.progress = payload.progress;
  applyRemoteVoiceProgress(payload.messageId, payload.progress, payload.active === true, payload.staleAt);
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
      const nextReadAt = receipt.readAt ?? message.readAt;
      if (nextDeliveredAt && nextDeliveredAt !== message.deliveredAt) { message.deliveredAt = nextDeliveredAt; changed = true; }
      if (nextReadAt && nextReadAt !== message.readAt) { message.readAt = nextReadAt; changed = true; }
    }
    if (changed) renderMessages({ preserveVoicePlayback: true });
  }

  const chat = chats.find((candidate) => candidate.conversationId === payload.conversationId);
  if (chat?.lastMessage) {
    const receipt = receipts.find(
      (candidate) => candidate.messageId === chat.lastMessage.messageId ||
        candidate.clientMessageId === chat.lastMessage.clientMessageId
    );
    if (receipt?.deliveredAt) chat.lastMessage.deliveredAt = receipt.deliveredAt;
    if (receipt?.readAt) chat.lastMessage.readAt = receipt.readAt;
    if (receipt) renderChats();
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

function captureMessageFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const item = active.closest(".message[data-message-id]");
  if (!item) return null;
  return {
    messageId: item.dataset.messageId,
    tagName: active.tagName,
    ariaLabel: active.getAttribute("aria-label"),
    text: active instanceof HTMLButtonElement ? active.textContent : null
  };
}

function restoreMessageFocus(state) {
  if (!state?.messageId) return;
  const item = [...elements.messageList.querySelectorAll(".message[data-message-id]")]
    .find((candidate) => candidate.dataset.messageId === state.messageId);
  if (!item) return;
  const candidates = item.querySelectorAll("button, input, select, textarea, [tabindex]");
  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement) || candidate.tagName !== state.tagName) continue;
    const labelMatches = state.ariaLabel && candidate.getAttribute("aria-label") === state.ariaLabel;
    const textMatches = state.text && candidate instanceof HTMLButtonElement && candidate.textContent === state.text;
    if (labelMatches || textMatches) {
      candidate.focus({ preventScroll: true });
      return;
    }
  }
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `cm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

account = getCurrentAccount();
