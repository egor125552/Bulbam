import { logDiagnostic, logTraceEvent, diagnosticErrorName } from "./diagnostics-log.js";
import { language, translateText } from "./i18n.js";
import { api } from "./api.js";
import { chatAccessibleLabel, chatPreview, chatTimeLabel, dayKey, dayLabel, isNearBottom, messageDeliveryState, messageTime } from "./chat-presentation.js";
import { filePreviewText } from "./file-format.js";
import { renderFileMessage, resetFileMedia } from "./file-message.js";
import { buildMessageReadingText, deliveryStatusSummary, formatDurationSpoken } from "./message-reading-core.js";
import { getMessageReadingMode } from "./message-reading.js";
import { buildAccessibleLinksBar, renderLinkifiedText } from "./message-links.js";
import { announce, elements, getCurrentAccount } from "./ui.js";
import { subscribeRealtime, reconnectRealtime, realtimeConnected } from "./shared-realtime.js";
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
let unsubscribeRealtime = null;
let pollTimer = null;
let generation = 0;
let jumpButton = null;
let presenceByUserId = new Map();
let groupCandidates=new Map();
let groupSelected=new Set();
let groupEditorMode='create';
let groupEditorConversation=null;
let groupSearchTimer=null;
let replyTarget = null;
let editTarget = null;
let actionMessage = null;
let actionReturnFocus = null;
let forwardSourceMessage = null;
let favoritesItems = [];
let highlightTimer = null;

const REACTION_CHOICES = [
  { emoji: "👍", label: "Нравится" },
  { emoji: "❤️", label: "Сердце" },
  { emoji: "🔥", label: "Огонь" },
  { emoji: "😂", label: "Смех" },
  { emoji: "😮", label: "Удивление" },
  { emoji: "😢", label: "Грусть" },
  { emoji: "👏", label: "Аплодисменты" },
  { emoji: "🙏", label: "Спасибо" }
];

export function setupMessenger() {
  jumpButton = document.querySelector("#jump-to-latest");
  jumpButton?.addEventListener("click", jumpToLatest);
  elements.messageList.addEventListener("scroll", () => {
    if (jumpButton && isNearBottom(elements.messageList)) jumpButton.hidden = true;
  });
  elements.newChatButton.addEventListener("click", toggleSearchPanel);
  setupGroupEditor();
  setupMessageActions();
  elements.userSearchInput.addEventListener("input", scheduleUserSearch);
  elements.userSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearchPanel();
  });
  elements.messageForm.addEventListener("submit", sendCurrentMessage);
  elements.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && editTarget) {
      event.preventDefault();
      clearEditTarget({ announceCancel: true, restoreDraft: true });
      return;
    }
    if (event.key === "Escape" && replyTarget) {
      event.preventDefault();
      clearReplyTarget({ announceCancel: true });
      return;
    }
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
    if(selectedChat){renderMessages({preserveVoicePlayback:true});updatePeerPresence();}
    else renderConversation();
  });
  window.addEventListener("bulbam:reading-mode-changed", () => {
    if (!account || !selectedChat) return;
    renderMessages({ preserveVoicePlayback: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !account) return;
    const callActive = document.documentElement?.dataset?.bulbamCallActive === "true";
    const callMinimized = Boolean(document.querySelector("#call-panel")?.classList.contains("is-minimized"));
    if (!callActive || callMinimized) void refreshVisibleState();
    if (!realtimeConnected()) reconnectRealtime({ resetBackoff: true });
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
  logTraceEvent('Навигация','смена пользователя','',{active:Boolean(nextAccount)});
  chats = [];
  presenceByUserId.clear();
  selectedChat = null;
  messages = [];
  resetVoicePlayers();
  resetFileMedia();
  stopRealtime();
  stopPolling();
  closeSearchPanel();
  clearReplyTarget();
  clearEditTarget();
  actionMessage = null;
  actionReturnFocus = null;
  forwardSourceMessage = null;
  favoritesItems = [];
  document.querySelector('#group-editor')?.close?.();
  document.querySelector('#group-members-dialog')?.close?.();
  document.querySelector('#message-actions-dialog')?.close?.();
  document.querySelector('#forward-dialog')?.close?.();
  document.querySelector('#favorites-dialog')?.close?.();
  groupCandidates.clear();groupSelected.clear();
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
    logDiagnostic("Навигация", "чат открыт");
  } catch (error) {
    announce(`Не удалось открыть чат: ${error.message}`);
  }
}

async function loadChats({ quiet = false } = {}) {
  if (!account) return;
  try {
    const result = await api("/api/v1/chats");
    chats = result.chats ?? [];
    logTraceEvent('Сервер','список чатов получен','',{count:chats.length});
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
    if(chat.kind==='group')button.dataset.groupIcon=chat.avatarIcon??'👥';
    if (selectedChat?.conversationId === chat.conversationId) {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "page");
    }

    const name = document.createElement("strong");
    name.dataset.userContent = "true";
    name.textContent = chat.kind==='group'?chat.title:chat.peer.displayName;
    const username = document.createElement("span");
    username.className = "chat-username";
    username.dataset.userContent = "true";
    username.textContent = chat.kind==='group'?`${chat.members?.length??0} участников`:`@${chat.peer.username}`;

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
    if(chat.kind!=='group')presence.dataset.presenceUserId=chat.peer.userId;
    presence.textContent=chat.kind==='group'?groupPresenceLabel(chat):presenceLabel(chat.peer.userId);
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
  clearReplyTarget();
  clearEditTarget();
  if (jumpButton) jumpButton.hidden = true;
  messages = [];
  resetVoicePlayers();
  resetFileMedia();
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
    logTraceEvent('Сервер','история чата загружена','',{messages:serverMessages.length});
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
  resetFileMedia();
  elements.messageList.replaceChildren();
  if (!account || !chat) {
    elements.conversationTitle.textContent = translateText("Выберите чат");
    elements.conversationPeer.textContent = translateText("Найди человека или открой существующий диалог.");
    elements.conversationEmpty.hidden = false;
    const groupInfo=document.querySelector('#group-info-open');
    if(groupInfo)groupInfo.hidden=true;
    elements.messageForm.hidden = true;
    delete elements.messageForm.dataset.conversationId;
    delete elements.messageForm.dataset.chatKind;
    delete elements.conversationTitle.dataset.avatarIcon;
    return;
  }

  elements.messageForm.dataset.conversationId = chat.conversationId;
  elements.messageForm.dataset.chatKind = chat.kind??'direct';
  elements.conversationTitle.dataset.avatarIcon = chat.kind==='group'?chat.avatarIcon??'👥':'';
  elements.conversationTitle.textContent = chat.kind==='group'?chat.title:chat.peer.displayName;
  elements.conversationPeer.textContent = chat.kind==='group'
    ? `${chat.members?.length??0} участников · ${groupPresenceLabel(chat)}`
    : `@${chat.peer.username} · ${presenceLabel(chat.peer.userId)}`;
  const groupInfo=document.querySelector('#group-info-open');
  if(groupInfo)groupInfo.hidden=chat.kind!=='group';
  elements.callStartButton.hidden=false;
  const callLabel = translateText(chat.kind==='group' ? 'Позвонить в группу' : 'Позвонить');
  elements.callStartButton.setAttribute('aria-label', callLabel);
  elements.conversationEmpty.hidden = true;
  elements.messageForm.hidden = false;
  renderMessages();
}

function presenceLabel(userId) {
  return presenceByUserId.get(userId)?.label ?? translateText("Статус неизвестен");
}

function peerChatLabel(chat) {
  if(chat.kind==='group')return `Группа ${chat.title}. ${chat.members?.length??0} участников. ${groupPresenceLabel(chat)}. ${chatPreview(chat.lastMessage,account?.userId)}. Открыть чат`;
  return chatAccessibleLabel(chat, account?.userId) + ". " + presenceLabel(chat.peer.userId);
}
function groupPresenceLabel(chat){
  const count=(chat.members??[]).filter(member=>member.userId===account?.userId
    ?document.visibilityState==='visible':presenceByUserId.get(member.userId)?.online===true).length;
  return `${count} в сети`;
}

function updatePeerPresence() {
  if (!account)return;
  for (const chat of chats) {
    const button=[...elements.chatList.querySelectorAll(".chat-item")]
      .find(element=>element.dataset.conversationId===chat.conversationId);
    if (!button)continue;
    const span=button.querySelector(".chat-presence");
    if(span)span.textContent=chat.kind==='group'?groupPresenceLabel(chat):presenceLabel(chat.peer.userId);
    button.setAttribute("aria-label",peerChatLabel(chat));
  }
  if(selectedChat)elements.conversationPeer.textContent=selectedChat.kind==='group'
    ? `${selectedChat.members?.length??0} участников · ${groupPresenceLabel(selectedChat)}`
    : `@${selectedChat.peer.username} · ${presenceLabel(selectedChat.peer.userId)}`;
}

function renderMessages({ preserveVoicePlayback = false, scrollToBottom = false } = {}) {
  const list = elements.messageList;
  const readingMode = getMessageReadingMode();
  const locale = language();
  const wasNearBottom = isNearBottom(list);
  const oldScrollTop = list.scrollTop;
  const previousIds = new Set([...list.querySelectorAll(".message[data-message-id]")]
    .map((item) => item.dataset.messageId));
  const playbackState = preserveVoicePlayback ? captureVoicePlaybackState() : [];
  const focusState = preserveVoicePlayback ? captureMessageFocus() : null;
  resetVoicePlayers();
  list.replaceChildren();
  list.dataset.readingMode = readingMode;
  if (readingMode === "table") list.setAttribute("role", "presentation");
  else list.removeAttribute("role");

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

  if (readingMode === "table") {
    renderMessagesAsTable(list, locale);
  } else {
    renderMessagesAsList(list, readingMode, locale);
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

function resolveMessageAuthor(message, mine) {
  if (mine) return "Вы";
  if (selectedChat.kind === "group") {
    return selectedChat.members?.find((member) => member.userId === message.senderUserId)?.displayName ?? "Участник";
  }
  return selectedChat.peer.displayName;
}

function buildMessageMetaNode(message, mine) {
  const meta = document.createElement("span");
  meta.className = "message-meta";
  const time = document.createElement("time");
  const validDate = new Date(message.createdAt);
  if (Number.isFinite(validDate.getTime())) time.dateTime = validDate.toISOString();
  time.textContent = messageTime(message.createdAt);
  meta.append(time);

  if (message.editedAt && !message.localState) {
    const edited = document.createElement("span");
    edited.className = "message-edited-badge";
    edited.textContent = ` · ${translateText("изменено")}`;
    meta.append(edited);
  }
  const state = message.localState === "pending"
    ? "отправляется"
    : message.localState === "failed"
      ? "не отправлено"
      : mine
        ? message.readAt ? "прочитано" : message.deliveredAt ? "доставлено" : "отправлено"
        : "";
  if (state && !(mine && selectedChat.kind === "group")) {
    const stateLabel = document.createElement("span");
    stateLabel.textContent = ` · ${translateText(state)}`;
    meta.append(stateLabel);
  }
  if (message.isFavorite && !message.localState) {
    const fav = document.createElement("span");
    fav.className = "message-favorite-badge";
    fav.textContent = `★ ${translateText("В избранном")}`;
    meta.append(fav);
  }
  return meta;
}

function messageSnippetText(message) {
  if (!message) return "";
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }
  if (message.kind === "voice") {
    return translateText("Голосовое сообщение");
  }
  if (message.kind === "file" && message.file) {
    return filePreviewText(message.file, message.text);
  }
  return translateText("Сообщение");
}

function buildForwardedNode(message) {
  const fromName = message?.forwardedFrom?.fromDisplayName || message?.forwardedFrom?.displayName;
  if (!fromName) return null;
  const badge = document.createElement("span");
  badge.className = "message-forwarded-badge";
  badge.dataset.userContent = "true";
  badge.textContent = `${translateText("Переслано от")} ${fromName}`;
  return badge;
}

function buildReplyQuoteNode(message) {
  if (!message?.replyTo) return null;
  const reply = message.replyTo;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-reply-quote${reply.deleted ? " is-deleted" : ""}`;
  const author = document.createElement("strong");
  author.dataset.userContent = "true";
  author.textContent = reply.deleted
    ? translateText("Ответ на сообщение")
    : (reply.senderDisplayName || translateText("Участник"));
  const excerpt = document.createElement("span");
  excerpt.dataset.userContent = "true";
  excerpt.textContent = reply.deleted
    ? translateText("Сообщение удалено")
    : (reply.text || translateText("Сообщение"));
  button.append(author, excerpt);
  button.setAttribute(
    "aria-label",
    reply.deleted
      ? translateText("В ответ на удалённое сообщение")
      : `${translateText("В ответ на сообщение от")} ${author.textContent}: ${excerpt.textContent}. ${translateText("Перейти к исходному сообщению")}`
  );
  button.addEventListener("click", () => jumpToMessageById(reply.messageId));
  return button;
}

function buildReactionsNode(message) {
  if (!Array.isArray(message?.reactions) || !message.reactions.length || message.localState) return null;
  const bar = document.createElement("div");
  bar.className = "message-reactions-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", translateText("Реакции"));
  for (const reaction of message.reactions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `reaction-chip${reaction.reactedByMe ? " is-active" : ""}`;
    chip.setAttribute("aria-pressed", String(Boolean(reaction.reactedByMe)));
    const choice = REACTION_CHOICES.find((item) => item.emoji === reaction.emoji);
    const labelName = choice ? translateText(choice.label) : reaction.emoji;
    chip.setAttribute(
      "aria-label",
      `${labelName} ${reaction.emoji}, ${reaction.count}${reaction.reactedByMe ? `, ${translateText("вы поставили")}` : ""}`
    );
    chip.textContent = `${reaction.emoji} ${reaction.count}`;
    chip.addEventListener("click", () => void toggleMessageReaction(message, reaction.emoji));
    bar.append(chip);
  }
  return bar;
}

function buildMessageActionsTrigger(message) {
  if (message.localState) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-actions-trigger";
  button.setAttribute("aria-label", translateText("Открыть меню действий с сообщением"));
  button.title = translateText("Действия с сообщением");
  const dots = document.createElement("span");
  dots.setAttribute("aria-hidden", "true");
  dots.textContent = "⋯";
  button.append(dots);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openMessageActions(message, button);
  });
  return button;
}

function attachMessageContextMenu(container, message, trigger) {
  if (message.localState) return;
  container.addEventListener("contextmenu", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("a, input, textarea")) return;
    event.preventDefault();
    openMessageActions(message, trigger ?? container);
  });
}

function buildGroupReadersDetails(message, mine) {
  if (!mine || selectedChat.kind !== "group" || message.localState) return null;
  const readers = message.readBy ?? [];
  const total = Math.max(readers.length, message.eligibleRecipientCount ?? (selectedChat.members?.length ?? 1) - 1);
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Прочитали: ${readers.length} из ${total}`;
  const names = document.createElement("p");
  names.textContent = readers.length
    ? readers.map((reader) => selectedChat.members?.find((member) => member.userId === reader.userId)?.displayName ?? "Участник").join(", ")
    : "Пока никто не прочитал";
  details.append(summary, names);
  return details;
}

function buildRetryButton(message) {
  if (message.localState !== "failed" || message.kind === "voice") return null;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-message";
  retry.textContent = translateText("Повторить отправку");
  retry.addEventListener("click", () => void transmitPending(message));
  return retry;
}

function renderMessagesAsList(list, readingMode, locale) {
  const isUnified = readingMode === "single" || readingMode === "telegram";
  const isGroup = selectedChat.kind === "group";
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

    const authorName = resolveMessageAuthor(message, mine);
    const author = document.createElement("span");
    author.className = "message-author";
    author.textContent = authorName;
    if (!mine) author.dataset.userContent = "true";

    const meta = buildMessageMetaNode(message, mine);
    const forwardedNode = buildForwardedNode(message);
    const replyQuoteNode = buildReplyQuoteNode(message);
    const reactionsNode = buildReactionsNode(message);
    const actionsTrigger = buildMessageActionsTrigger(message);
    const readersDetails = buildGroupReadersDetails(message, mine);
    const retryButton = buildRetryButton(message);
    attachMessageContextMenu(item, message, actionsTrigger);

    if (isUnified) {
      const spokenSummary = buildMessageReadingText(message, {
        mode: readingMode,
        mine,
        authorName,
        isGroup,
        locale,
        translate: translateText
      });

      if (message.kind === "voice" && message.voice) {
        const voiceNode = renderVoiceMessage(message, mine);
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "message-voice-summary-trigger";
        trigger.setAttribute("aria-label", spokenSummary);
        trigger.textContent = `${translateText("Воспроизвести голосовое")} · ${formatDurationSpoken(message.voice.durationMs, translateText)}`;
        trigger.addEventListener("click", () => {
          voiceNode.querySelector(".voice-actions button")?.click();
        });
        author.setAttribute("aria-hidden", "true");
        meta.setAttribute("aria-hidden", "true");
        if (forwardedNode) forwardedNode.setAttribute("aria-hidden", "true");
        item.append(trigger);
        if (forwardedNode) item.append(forwardedNode);
        if (replyQuoteNode) item.append(replyQuoteNode);
        item.append(author, voiceNode);
        if (reactionsNode) item.append(reactionsNode);
        const footer = document.createElement("div");
        footer.className = "message-footer-row";
        footer.append(meta);
        if (actionsTrigger) footer.append(actionsTrigger);
        item.append(footer);
      } else if (message.kind === "file" && message.file) {
        const summarySpan = document.createElement("span");
        summarySpan.className = "visually-hidden";
        summarySpan.textContent = spokenSummary;
        author.setAttribute("aria-hidden", "true");
        meta.setAttribute("aria-hidden", "true");
        if (forwardedNode) forwardedNode.setAttribute("aria-hidden", "true");
        item.append(summarySpan);
        if (forwardedNode) item.append(forwardedNode);
        if (replyQuoteNode) item.append(replyQuoteNode);
        item.append(author, renderFileMessage(message, authorName));
        if (reactionsNode) item.append(reactionsNode);
        const footer = document.createElement("div");
        footer.className = "message-footer-row";
        footer.append(meta);
        if (actionsTrigger) footer.append(actionsTrigger);
        item.append(footer);
      } else {
        const surface = document.createElement("span");
        surface.className = "message-reading-surface";
        surface.textContent = spokenSummary;

        const visualBody = document.createElement("div");
        visualBody.className = "message-visual-body";
        visualBody.setAttribute("aria-hidden", "true");

        if (forwardedNode) visualBody.append(forwardedNode);
        const body = document.createElement("p");
        body.dataset.userContent = "true";
        const links = renderLinkifiedText(body, message.text);
        visualBody.append(author, body, meta);
        item.append(surface, visualBody);
        const accessibleLinksBar = buildAccessibleLinksBar(links, translateText);
        if (accessibleLinksBar) item.append(accessibleLinksBar);
        if (replyQuoteNode) item.append(replyQuoteNode);
        if (reactionsNode) item.append(reactionsNode);
        if (actionsTrigger) {
          const footer = document.createElement("div");
          footer.className = "message-footer-row";
          footer.append(actionsTrigger);
          item.append(footer);
        }
      }

      if (readersDetails) item.append(readersDetails);
      if (retryButton) item.append(retryButton);
      list.append(item);
      continue;
    }

    if (forwardedNode) item.append(forwardedNode);
    item.append(author);
    if (replyQuoteNode) item.append(replyQuoteNode);
    if (message.kind === "voice" && message.voice) {
      item.append(renderVoiceMessage(message, mine));
    } else if (message.kind === "file" && message.file) {
      item.append(renderFileMessage(message, authorName));
    } else {
      const body = document.createElement("p");
      body.dataset.userContent = "true";
      renderLinkifiedText(body, message.text);
      item.append(body);
    }
    if (reactionsNode) item.append(reactionsNode);
    const footer = document.createElement("div");
    footer.className = "message-footer-row";
    footer.append(meta);
    if (actionsTrigger) footer.append(actionsTrigger);
    item.append(footer);
    if (readersDetails) item.append(readersDetails);
    if (retryButton) item.append(retryButton);
    list.append(item);
  }
}

function renderMessagesAsTable(list, locale) {
  const isGroup = selectedChat.kind === "group";
  const wrapper = document.createElement("li");
  wrapper.className = "message-table-shell";
  wrapper.setAttribute("role", "presentation");

  const table = document.createElement("table");
  table.className = "message-table";
  table.setAttribute("aria-label", translateText("Сообщения"));

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const colTitle of ["Отправитель", "Сообщение", "Время и статус"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = translateText(colTitle);
    headerRow.append(th);
  }
  thead.append(headerRow);

  const tbody = document.createElement("tbody");
  let lastDay = "";

  for (const message of messages) {
    const currentDay = dayKey(message.createdAt);
    if (currentDay !== lastDay) {
      const dayRow = document.createElement("tr");
      dayRow.className = "message-table-day";
      const dayHeader = document.createElement("th");
      dayHeader.colSpan = 3;
      dayHeader.scope = "colgroup";
      dayHeader.textContent = dayLabel(message.createdAt);
      dayRow.append(dayHeader);
      tbody.append(dayRow);
      lastDay = currentDay;
    }

    const mine = message.senderUserId === account?.userId;
    const authorName = resolveMessageAuthor(message, mine);
    const row = document.createElement("tr");
    row.className = `message message-table-row ${mine ? "message-mine" : "message-theirs"}`;
    row.dataset.messageId = message.messageId;
    if (message.localState) row.classList.add(`message-${message.localState}`);

    const authorCell = document.createElement("td");
    authorCell.className = "message-cell-author";
    authorCell.textContent = authorName;
    if (!mine) authorCell.dataset.userContent = "true";

    const contentCell = document.createElement("td");
    contentCell.className = "message-cell-content";
    const forwardedNode = buildForwardedNode(message);
    const replyQuoteNode = buildReplyQuoteNode(message);
    const reactionsNode = buildReactionsNode(message);
    const actionsTrigger = buildMessageActionsTrigger(message);
    attachMessageContextMenu(row, message, actionsTrigger);

    if (forwardedNode) contentCell.append(forwardedNode);
    if (replyQuoteNode) contentCell.append(replyQuoteNode);
    if (message.kind === "voice" && message.voice) {
      contentCell.append(renderVoiceMessage(message, mine));
    } else if (message.kind === "file" && message.file) {
      contentCell.append(renderFileMessage(message, authorName));
    } else {
      const body = document.createElement("p");
      body.dataset.userContent = "true";
      renderLinkifiedText(body, message.text);
      contentCell.append(body);
    }
    if (reactionsNode) contentCell.append(reactionsNode);

    const metaCell = document.createElement("td");
    metaCell.className = "message-cell-meta";
    const time = document.createElement("time");
    const validDate = new Date(message.createdAt);
    if (Number.isFinite(validDate.getTime())) time.dateTime = validDate.toISOString();
    time.textContent = messageTime(message.createdAt);
    metaCell.append(time);

    if (message.editedAt && !message.localState) {
      const edited = document.createElement("span");
      edited.className = "message-edited-badge";
      edited.textContent = ` · ${translateText("изменено")}`;
      metaCell.append(edited);
    }

    const statusSummary = deliveryStatusSummary(message, { mine, isGroup, verbose: false, translate: translateText });
    if (statusSummary) {
      const statusSpan = document.createElement("span");
      statusSpan.textContent = ` · ${statusSummary}`;
      metaCell.append(statusSpan);
    }
    if (message.isFavorite && !message.localState) {
      const fav = document.createElement("span");
      fav.className = "message-favorite-badge";
      fav.textContent = `★ ${translateText("В избранном")}`;
      metaCell.append(fav);
    }

    if (actionsTrigger) {
      const actionWrap = document.createElement("div");
      actionWrap.className = "message-footer-row";
      actionWrap.append(actionsTrigger);
      metaCell.append(actionWrap);
    }

    const readersDetails = buildGroupReadersDetails(message, mine);
    if (readersDetails) metaCell.append(readersDetails);
    const retryButton = buildRetryButton(message);
    if (retryButton) metaCell.append(retryButton);

    row.append(authorCell, contentCell, metaCell);
    tbody.append(row);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  list.append(wrapper);
}

function jumpToLatest() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
  if (jumpButton) jumpButton.hidden = true;
  const allMessages = elements.messageList.querySelectorAll(".message");
  const latest = allMessages[allMessages.length - 1];
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

  if (editTarget && editTarget.conversationId === selectedChat.conversationId) {
    await saveEditedMessage(editTarget, text);
    return;
  }

  const activeReply = replyTarget && replyTarget.conversationId === selectedChat.conversationId ? replyTarget : null;
  const pending = {
    messageId: `pending_${randomId()}`,
    conversationId: selectedChat.conversationId,
    senderUserId: account.userId,
    clientMessageId: randomId(),
    kind: "text",
    text,
    voice: null,
    replyToMessageId: activeReply?.messageId ?? null,
    replyTo: activeReply
      ? {
          messageId: activeReply.messageId,
          senderUserId: activeReply.senderUserId,
          senderDisplayName: activeReply.authorName,
          kind: activeReply.kind,
          text: activeReply.snippet,
          deleted: false
        }
      : null,
    forwardedFrom: null,
    reactions: [],
    isFavorite: false,
    createdAt: Date.now(),
    deliveredAt: null,
    localState: "pending"
  };
  messages.push(pending);
  logTraceEvent('Интерфейс','сообщение поставлено в очередь','',{count:messages.length});
  elements.messageInput.value = "";
  clearReplyTarget();
  renderMessages({ preserveVoicePlayback: true, scrollToBottom: true });
  await transmitPending(pending);
}

async function transmitPending(pending) {
  if (!account || !selectedChat || pending.conversationId !== selectedChat.conversationId) return;
  pending.localState = "pending";
  logDiagnostic('Сеть','повтор или начало отправки текста');
  renderMessages({ preserveVoicePlayback: true });
  try {
    const body = {
      clientMessageId: pending.clientMessageId,
      text: pending.text
    };
    if (pending.replyToMessageId) body.replyToMessageId = pending.replyToMessageId;
    const result = await api(`/api/v1/chats/${pending.conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    upsertServerMessage(result.message);
    logDiagnostic('Сеть','сообщение подтверждено сервером');
    announce("Сообщение отправлено.");
    await loadChats({ quiet: true });
  } catch (error) {
    pending.localState = "failed";
    logDiagnostic('Ошибки','сообщение не отправлено',diagnosticErrorName(error));
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
  logTraceEvent('Сеть','подтверждения сообщений подготовлены','',{messages:incoming.length,count:readIds.length,chunks:deliveredIds.length});
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
  if (!account || unsubscribeRealtime) return;
  logDiagnostic("Сеть", "начало подключения сокета сообщений");
  unsubscribeRealtime = subscribeRealtime(account.userId, {
    open: () => {
      logDiagnostic("Сеть", "сокет сообщений подключён");
      stopPolling();
    },
    message: (payload) => handleRealtimePayload(payload),
    close: () => {
      logDiagnostic("Сеть", "сокет сообщений отключён");
      if (account) startPolling();
    }
  });
}

function handleRealtimePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const known = [
    "message.created", "message.edited", "message.deleted", "message.reactions.updated", "favorites.updated",
    "messages.delivered", "messages.read", "voice.progress", "chat.created", "chat.updated", "chat.removed"
  ];
  logDiagnostic("Сеть", "получено событие сокета", known.includes(payload?.type) ? payload.type : "другое");
  if (payload?.type === "message.created" && payload.message) {
    logDiagnostic("Сервер", "событие новое сообщение");
    handleRealtimeMessage(payload);
  } else if (payload?.type === "message.edited" && payload.message) {
    handleRealtimeMessageEdited(payload);
  } else if (payload?.type === "message.deleted" && payload.messageId) {
    handleRealtimeMessageDeleted(payload);
  } else if (payload?.type === "message.reactions.updated" && payload.messageId) {
    handleRealtimeReactionsUpdated(payload);
  } else if (payload?.type === "favorites.updated" && payload.messageId) {
    handleRealtimeFavoritesUpdated(payload);
  } else if (payload?.type === "chat.removed") {
    if (selectedChat?.conversationId === payload.conversationId) { selectedChat = null; messages = []; clearReplyTarget(); clearEditTarget(); renderConversation(); }
    void loadChats({ quiet: true });
  } else if (payload?.type === "chat.created" || payload?.type === "chat.updated") {
    void loadChats({ quiet: true });
  } else if ((payload?.type === "messages.delivered" || payload?.type === "messages.read") && Array.isArray(payload.receipts)) {
    handleDeliveredReceipts(payload);
  } else if (payload?.type === "voice.progress" && payload.messageId && payload.progress) {
    handleVoiceProgress(payload);
  } else if (payload?.type === "admin.recovery.request") {
    window.dispatchEvent(new Event("bulbam:admin-recovery-request"));
  } else if (payload?.type === "admin.recovery.updated") {
    window.dispatchEvent(new Event("bulbam:admin-recovery-updated"));
  } else if (payload?.type === "owner.users.updated") {
    window.dispatchEvent(new Event("bulbam:owner-users-updated"));
  } else if (payload?.type === "session.revoked") {
    window.dispatchEvent(new Event("bulbam:session-revoked"));
  } else if (payload?.type === "account.deleted") {
    window.dispatchEvent(new CustomEvent("bulbam:account-deleted", { detail: { reason: payload.reason || "" } }));
  }
}

function handleRealtimeMessage(payload) {
  const chat = chats.find((candidate) => candidate.conversationId === payload.conversationId);
  if (selectedChat?.conversationId === payload.conversationId) {
    upsertServerMessage(payload.message);
  }
  void loadChats({ quiet: true });

  if (payload.message.senderUserId !== account?.userId) {
    void acknowledgeIncomingMessages(payload.conversationId, [payload.message]);
    const author=chat?.kind==='group'
      ? chat.members?.find(member=>member.userId===payload.message.senderUserId)?.displayName??'участника'
      :chat?.peer?.displayName??'собеседника';
    if (payload.message.kind === "file" && payload.message.file) {
      const fileSummary = filePreviewText(payload.message.file, payload.message.text);
      announce(chat?.kind==='group'
        ? `Новое сообщение в группе ${chat.title} от ${author}: ${fileSummary}.`
        : `Новое сообщение от ${author}: ${fileSummary}.`);
    } else {
      announce(chat?.kind==='group'?`Новое сообщение в группе ${chat.title} от ${author}.`:`Новое сообщение от ${author}.`);
    }
  }
}

function handleVoiceProgress(payload) {
  if (selectedChat?.conversationId !== payload.conversationId) return;
  const message = messages.find((candidate) => candidate.messageId === payload.messageId);
  if (message?.voice) message.voice.progress = payload.progress;
  applyRemoteVoiceProgress(payload.messageId, payload.progress, payload.active === true, payload.staleAt);
}

function handleDeliveredReceipts(payload) {
  if(selectedChat?.kind==='group'&&selectedChat.conversationId===payload.conversationId){
    void loadMessages({quiet:true});
  }
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

function stopRealtime() {
  if (unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
}

function startPolling() {
  if (pollTimer || !account) return;
  logDiagnostic('Сеть','резервный опрос включен');
  pollTimer = setInterval(() => void refreshVisibleState(), 5000);
}

function stopPolling() {
  if(pollTimer)logDiagnostic('Сеть','резервный опрос остановлен');
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshVisibleState() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
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

function setupGroupEditor(){
  const editor=document.querySelector('#group-editor');
  const membersDialog=document.querySelector('#group-members-dialog');
  document.querySelector('#create-group-open')?.addEventListener('click',()=>openGroupEditor('create'));
  document.querySelector('#group-cancel')?.addEventListener('click',()=>editor.close());
  document.querySelector('#group-editor-form')?.addEventListener('submit',saveGroup);
  document.querySelector('#group-user-search')?.addEventListener('input',()=>{
    clearTimeout(groupSearchTimer);
    const query=document.querySelector('#group-user-search').value.trim();
    if(query.length<2){renderGroupChoices();return;}
    groupSearchTimer=setTimeout(()=>void searchGroupUsers(query),250);
  });
  document.querySelector('#group-info-open')?.addEventListener('click',()=>void openGroupMembers());
  document.querySelector('#group-members-close')?.addEventListener('click',()=>membersDialog.close());
  document.querySelector('#group-members-add')?.addEventListener('click',()=>{
    membersDialog.close();openGroupEditor('add');
  });
}

function openGroupEditor(mode){
  groupEditorMode=mode;
  groupEditorConversation=mode==='add'?selectedChat?.conversationId:null;
  if(mode==='add'&&selectedChat?.kind!=='group')return;
  closeSearchPanel();
  groupSelected=new Set();groupCandidates=new Map();
  const currentIds=new Set(mode==='add'?(selectedChat?.members??[]).map(m=>m.userId):[]);
  for(const chat of chats){
    if(chat.kind==='group'||!chat.peer||currentIds.has(chat.peer.userId)||chat.peer.userId===account?.userId)continue;
    groupCandidates.set(chat.peer.userId,chat.peer);
  }
  const editor=document.querySelector('#group-editor');
  document.querySelector('#group-create-fields').hidden=mode==='add';
  document.querySelector('#group-editor-title').textContent=mode==='add'?'Добавить участников':'Создать группу';
  document.querySelector('#group-submit').textContent=mode==='add'?'Добавить участников':'Создать группу';
  document.querySelector('#group-user-search').value='';
  document.querySelector('#group-editor-status').textContent='';
  if(mode==='create'){
    document.querySelector('#group-title-input').value='';
    document.querySelector('#group-icon-input').value='👥';
    document.querySelector('#group-history-input').value='since_join';
  }
  renderGroupChoices();editor.showModal();
  (mode==='create'?document.querySelector('#group-title-input'):document.querySelector('#group-user-search')).focus();
}

async function searchGroupUsers(query){
  try{
    const result=await api(`/api/v1/users/search?q=${encodeURIComponent(query)}`);
    if(document.querySelector('#group-user-search').value.trim()!==query)return;
    for(const user of result.users??[]){
      if(user.userId===account?.userId)continue;
      if(groupEditorMode==='add'&&(selectedChat?.members??[]).some(m=>m.userId===user.userId))continue;
      groupCandidates.set(user.userId,user);
    }
    renderGroupChoices();
  }catch(error){document.querySelector('#group-editor-status').textContent=`Поиск не удался: ${error.message}`;}
}

function renderGroupChoices(){
  const count=document.querySelector('#group-selected-count');
  count.textContent=`Выбрано: ${groupSelected.size}`;
  const picked=document.querySelector('#group-picked-users');
  picked.replaceChildren();
  for(const id of groupSelected){
    const user=groupCandidates.get(id);
    if(!user)continue;
    const li=document.createElement('li');const button=document.createElement('button');
    button.type='button';button.textContent=`${user.displayName} · Убрать`;
    button.setAttribute('aria-label',`Убрать ${user.displayName} из выбранных`);
    button.addEventListener('click',()=>{groupSelected.delete(id);renderGroupChoices();});
    li.append(button);picked.append(li);
  }
  const list=document.querySelector('#group-user-results');list.replaceChildren();
  const q=document.querySelector('#group-user-search').value.trim().toLocaleLowerCase();
  const users=[...groupCandidates.values()].filter(user=>!q||`${user.displayName} ${user.username}`.toLocaleLowerCase().includes(q));
  for(const user of users){
    const li=document.createElement('li');const button=document.createElement('button');
    button.type='button';button.className='group-user-choice';
    button.setAttribute('aria-pressed',String(groupSelected.has(user.userId)));
    button.textContent=`${user.displayName}, @${user.username}${groupSelected.has(user.userId)?' · Выбран':''}`;
    button.addEventListener('click',()=>{if(groupSelected.has(user.userId))groupSelected.delete(user.userId);else groupSelected.add(user.userId);renderGroupChoices();});
    li.append(button);list.append(li);
  }
  if(!users.length){const li=document.createElement('li');li.textContent='Совпадений нет. Найдите человека по имени.';list.append(li);}
}

async function saveGroup(event){
  event.preventDefault();
  const status=document.querySelector('#group-editor-status');
  const submit=document.querySelector('#group-submit');
  if(!groupSelected.size){status.textContent='Выберите хотя бы одного участника.';return;}
  const create=groupEditorMode==='create';
  const title=document.querySelector('#group-title-input').value.trim();
  if(create&&!title){status.textContent='Введите название группы.';return;}
  const conversationId=groupEditorConversation;
  const accountId=account?.userId;
  submit.disabled=true;status.textContent=create?'Создаём группу…':'Добавляем участников…';
  try{
    const url=create?'/api/v1/chats/groups':`/api/v1/chats/${conversationId}/members`;
    const payload=create?{
      title,avatarIcon:document.querySelector('#group-icon-input').value,
      historyMode:document.querySelector('#group-history-input').value,userIds:[...groupSelected]
    }:{userIds:[...groupSelected]};
    const result=await api(url,{method:'POST',body:JSON.stringify(payload)});
    if(account?.userId!==accountId)return;
    document.querySelector('#group-editor').close();
    await loadChats({quiet:true});
    if(create){const chat=chats.find(c=>c.conversationId===result.chat.conversationId)??result.chat;await selectChat(chat,{focusHeading:true});}
    else if(selectedChat?.conversationId===conversationId){
      selectedChat=chats.find(c=>c.conversationId===conversationId)??selectedChat;
      renderConversation();await loadMessages({quiet:true});
    }
    announce(create?'Группа создана.':'Участники добавлены.');
  }catch(error){status.textContent=`Не удалось сохранить группу: ${error.message}`;}
  finally{submit.disabled=false;}
}

async function openGroupMembers(){
  if(selectedChat?.kind!=='group')return;
  const id=selectedChat.conversationId;
  const dialog=document.querySelector('#group-members-dialog');
  document.querySelector('#group-members-title').textContent=`Участники группы ${selectedChat.title}`;
  document.querySelector('#group-members-presence').textContent=groupPresenceLabel(selectedChat);
  document.querySelector('#group-members-add').hidden=selectedChat.ownerUserId!==account?.userId;
  const list=document.querySelector('#group-members-list');list.replaceChildren();
  renderGroupMembersList(list);
  dialog.showModal();
  try{
    const response=await api(`/api/v1/chats/${id}/members`);
    if(selectedChat?.conversationId!==id||!dialog.open)return;
    selectedChat.members=response.members.map(member=>({userId:member.userId,...member.user}));
    updatePeerPresence();
    renderGroupMembersList(list);
  }catch{ /* Cached list remains visible offline. */ }
}

function renderGroupMembersList(list){
  list.replaceChildren();
  if(selectedChat?.kind!=='group')return;
  const owner=selectedChat.ownerUserId===account?.userId;
  for(const member of selectedChat.members??[]){
    const li=document.createElement('li');
    const info=document.createElement('span');
    info.textContent=`${member.displayName}, @${member.username}${member.userId===selectedChat.ownerUserId?' · создатель':''} · ${member.userId===account?.userId?'Вы':presenceLabel(member.userId)}`;
    li.append(info);
    const isMe=member.userId===account?.userId;
    if(member.userId!==selectedChat.ownerUserId&&(owner||isMe)){
      const action=document.createElement('button');action.type='button';
      action.textContent=isMe?'Выйти из группы':'Исключить из группы';
      action.setAttribute('aria-label',isMe?'Выйти из группы':`Исключить ${member.displayName} из группы`);
      action.addEventListener('click',()=>void removeGroupUser(member));
      li.append(action);
    }
    list.append(li);
  }
}

async function removeGroupUser(member){
  if(selectedChat?.kind!=='group'||!account)return;
  const own=member.userId===account.userId;
  if(!window.confirm(own?'Выйти из этой группы?':`Исключить ${member.displayName} из группы?`))return;
  const id=selectedChat.conversationId;
  try{
    await api(`/api/v1/chats/${id}/members/${member.userId}`,{method:'DELETE'});
    if(selectedChat?.conversationId!==id)return;
    document.querySelector('#group-members-dialog').close();
    if(own){selectedChat=null;messages=[];renderConversation();}
    await loadChats({quiet:true});
    announce(own?'Вы вышли из группы.':'Участник исключён из группы.');
  }catch(error){announce(`Не удалось изменить состав группы: ${error.message}`);}
}

/* ==========================================================================
   Message actions, replies, reactions, copy, forward, delete & favorites
   ========================================================================== */

function setupMessageActions() {
  const actionsDialog = document.querySelector("#message-actions-dialog");
  const forwardDialog = document.querySelector("#forward-dialog");
  const favoritesDialog = document.querySelector("#favorites-dialog");

  document.querySelector("#reply-preview-cancel")?.addEventListener("click", () => {
    clearReplyTarget({ announceCancel: true });
    elements.messageInput?.focus();
  });

  document.querySelector("#edit-preview-cancel")?.addEventListener("click", () => {
    clearEditTarget({ announceCancel: true, restoreDraft: true });
    elements.messageInput?.focus();
  });

  document.querySelector("#msg-action-reply")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const target = actionMessage;
    closeMessageActionsDialog({ restoreFocus: false });
    setReplyTarget(target);
  });

  document.querySelector("#msg-action-edit")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const target = actionMessage;
    closeMessageActionsDialog({ restoreFocus: false });
    startEditMessage(target);
  });

  document.querySelector("#msg-action-copy")?.addEventListener("click", () => {
    if (!actionMessage) return;
    void copyMessageText(actionMessage);
  });

  document.querySelector("#msg-action-forward")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const target = actionMessage;
    closeMessageActionsDialog({ restoreFocus: false });
    openForwardDialog(target);
  });

  document.querySelector("#msg-action-favorite")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const target = actionMessage;
    closeMessageActionsDialog({ restoreFocus: true });
    void toggleFavoriteMessage(target);
  });

  document.querySelector("#msg-action-delete")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const choices = document.querySelector("#msg-action-delete-choices");
    const deleteBtn = document.querySelector("#msg-action-delete");
    const everyoneBtn = document.querySelector("#msg-action-delete-everyone");
    if (!choices || !deleteBtn) return;
    const willShow = choices.hidden;
    choices.hidden = !willShow;
    deleteBtn.setAttribute("aria-expanded", String(willShow));
    if (everyoneBtn) {
      everyoneBtn.hidden = !canDeleteForEveryone(actionMessage);
    }
    if (willShow) {
      document.querySelector("#msg-action-delete-me")?.focus();
    }
  });

  document.querySelector("#msg-action-delete-me")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const target = actionMessage;
    closeMessageActionsDialog({ restoreFocus: false });
    void deleteMessageWithScope(target, "me");
  });

  document.querySelector("#msg-action-delete-everyone")?.addEventListener("click", () => {
    if (!actionMessage) return;
    const target = actionMessage;
    closeMessageActionsDialog({ restoreFocus: false });
    void deleteMessageWithScope(target, "everyone");
  });

  document.querySelector("#msg-action-delete-cancel")?.addEventListener("click", () => {
    const choices = document.querySelector("#msg-action-delete-choices");
    const deleteBtn = document.querySelector("#msg-action-delete");
    if (choices) choices.hidden = true;
    deleteBtn?.setAttribute("aria-expanded", "false");
    deleteBtn?.focus();
  });

  document.querySelector("#msg-action-close")?.addEventListener("click", () => {
    closeMessageActionsDialog({ restoreFocus: true });
  });

  actionsDialog?.addEventListener("cancel", () => {
    actionMessage = null;
    queueMicrotask(() => {
      if (actionReturnFocus instanceof HTMLElement && actionReturnFocus.isConnected) {
        actionReturnFocus.focus();
      }
      actionReturnFocus = null;
    });
  });

  document.querySelector("#forward-chat-filter")?.addEventListener("input", () => {
    renderForwardChatList();
  });
  document.querySelector("#forward-dialog-cancel")?.addEventListener("click", () => {
    forwardSourceMessage = null;
    forwardDialog?.close();
    if (actionReturnFocus instanceof HTMLElement && actionReturnFocus.isConnected) {
      actionReturnFocus.focus();
    }
  });

  document.querySelector("#favorites-open")?.addEventListener("click", () => {
    void openFavoritesDialog();
  });
  document.querySelector("#favorites-dialog-close")?.addEventListener("click", () => {
    favoritesDialog?.close();
    document.querySelector("#favorites-open")?.focus();
  });
}

function canEditMessage(message) {
  if (!message || message.localState || !account || !selectedChat) return false;
  if (message.senderUserId !== account.userId) return false;
  return message.kind === "text" && !message.file && !message.voice;
}

function canDeleteForEveryone(message) {
  if (!message || message.localState || !account || !selectedChat) return false;
  if (message.senderUserId === account.userId) return true;
  return selectedChat.kind === "group" && selectedChat.ownerUserId === account.userId;
}

function startEditMessage(message) {
  if (!canEditMessage(message)) return;
  clearReplyTarget();
  const previousDraft = editTarget ? editTarget.previousDraft : elements.messageInput.value;
  editTarget = {
    conversationId: selectedChat.conversationId,
    messageId: message.messageId,
    originalText: message.text ?? "",
    previousDraft
  };
  const bar = document.querySelector("#edit-preview-bar");
  const textEl = document.querySelector("#edit-preview-text");
  if (textEl) textEl.textContent = (message.text ?? "").trim().slice(0, 140);
  if (bar) bar.hidden = false;
  elements.messageForm.classList.add("composer-has-edit");
  const sendBtn = document.querySelector("#send-message");
  if (sendBtn) {
    sendBtn.setAttribute("aria-label", translateText("Сохранить изменения"));
    sendBtn.textContent = translateText("Сохранить");
  }
  elements.messageInput.value = message.text ?? "";
  elements.messageInput.focus();
  elements.messageInput.setSelectionRange(elements.messageInput.value.length, elements.messageInput.value.length);
  announce("Редактирование сообщения. Измените текст и нажмите Enter для сохранения или Escape для отмены.");
}

function clearEditTarget({ announceCancel = false, restoreDraft = false } = {}) {
  const previous = editTarget;
  editTarget = null;
  const bar = document.querySelector("#edit-preview-bar");
  if (bar) bar.hidden = true;
  elements.messageForm?.classList.remove("composer-has-edit");
  const sendBtn = document.querySelector("#send-message");
  if (sendBtn) {
    sendBtn.setAttribute("aria-label", translateText("Отправить сообщение"));
    sendBtn.textContent = translateText("Отправить");
  }
  if (previous && restoreDraft) {
    elements.messageInput.value = previous.previousDraft ?? "";
  }
  if (announceCancel && previous) announce("Редактирование отменено.");
}

async function saveEditedMessage(target, nextText) {
  if (!account || !selectedChat || !target) return;
  const normalizedOriginal = String(target.originalText ?? "").replace(/\r\n?/g, "\n").trim();
  if (nextText === normalizedOriginal) {
    const draft = target.previousDraft ?? "";
    clearEditTarget();
    elements.messageInput.value = draft;
    announce("Текст сообщения не изменился.");
    return;
  }
  const sendBtn = document.querySelector("#send-message");
  if (sendBtn) sendBtn.disabled = true;
  try {
    const result = await api(`/api/v1/chats/${target.conversationId}/messages/${target.messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ text: nextText })
    });
    const draft = target.previousDraft ?? "";
    clearEditTarget();
    elements.messageInput.value = draft;
    if (result?.message) {
      applyMessageEditedLocally(result.message);
    }
    announce("Сообщение изменено.");
    await loadChats({ quiet: true });
  } catch (error) {
    announce(`Не удалось изменить сообщение: ${error.message}`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

function applyMessageEditedLocally(updatedMessage) {
  if (!updatedMessage?.messageId) return;
  if (selectedChat?.conversationId === updatedMessage.conversationId) {
    const local = messages.find((candidate) => candidate.messageId === updatedMessage.messageId);
    if (local) {
      local.text = updatedMessage.text;
      local.editedAt = updatedMessage.editedAt ?? Date.now();
    }
    for (const candidate of messages) {
      if (candidate.replyTo?.messageId === updatedMessage.messageId && !candidate.replyTo.deleted) {
        candidate.replyTo = {
          ...candidate.replyTo,
          text: String(updatedMessage.text ?? "").slice(0, 160)
        };
      }
    }
    if (replyTarget?.messageId === updatedMessage.messageId) {
      replyTarget.snippet = String(updatedMessage.text ?? "").trim().slice(0, 140);
      const textEl = document.querySelector("#reply-preview-text");
      if (textEl) textEl.textContent = replyTarget.snippet;
    }
    if (actionMessage?.messageId === updatedMessage.messageId && document.querySelector("#message-actions-dialog")?.open) {
      actionMessage = local ?? updatedMessage;
      const preview = document.querySelector("#message-actions-preview");
      if (preview) {
        const mine = actionMessage.senderUserId === account?.userId;
        const authorName = resolveMessageAuthor(actionMessage, mine);
        preview.textContent = `${authorName}: ${messageSnippetText(actionMessage)}`;
      }
    }
    renderMessages({ preserveVoicePlayback: true });
  }
  const favDialog = document.querySelector("#favorites-dialog");
  if (favDialog?.open) void loadFavoritesIntoDialog();
}

function setReplyTarget(message) {
  if (!message || !selectedChat || message.localState) return;
  if (editTarget) clearEditTarget({ restoreDraft: true });
  const mine = message.senderUserId === account?.userId;
  const authorName = resolveMessageAuthor(message, mine);
  const snippet = messageSnippetText(message).slice(0, 140);
  replyTarget = {
    conversationId: selectedChat.conversationId,
    messageId: message.messageId,
    senderUserId: message.senderUserId,
    kind: message.kind,
    authorName,
    snippet
  };
  const bar = document.querySelector("#reply-preview-bar");
  const authorEl = document.querySelector("#reply-preview-author");
  const textEl = document.querySelector("#reply-preview-text");
  if (authorEl) authorEl.textContent = `${translateText("Ответ на")} ${authorName}`;
  if (textEl) textEl.textContent = snippet;
  if (bar) bar.hidden = false;
  elements.messageForm.classList.add("composer-has-reply");
  elements.messageInput.focus();
  announce(`Ответ на сообщение от ${authorName}.`);
}

function clearReplyTarget({ announceCancel = false } = {}) {
  const hadReply = Boolean(replyTarget);
  replyTarget = null;
  const bar = document.querySelector("#reply-preview-bar");
  if (bar) bar.hidden = true;
  elements.messageForm?.classList.remove("composer-has-reply");
  if (announceCancel && hadReply) announce("Ответ отменён.");
}

function openMessageActions(message, returnFocusEl) {
  const dialog = document.querySelector("#message-actions-dialog");
  if (!dialog || !message || message.localState) return;
  actionMessage = message;
  actionReturnFocus = returnFocusEl ?? document.activeElement;

  const mine = message.senderUserId === account?.userId;
  const authorName = resolveMessageAuthor(message, mine);
  const preview = document.querySelector("#message-actions-preview");
  if (preview) {
    preview.textContent = `${authorName}: ${messageSnippetText(message)}`;
  }

  renderDialogReactionButtons(message);

  const editBtn = document.querySelector("#msg-action-edit");
  if (editBtn) {
    editBtn.hidden = !canEditMessage(message);
  }

  const copyBtn = document.querySelector("#msg-action-copy");
  if (copyBtn) {
    const hasCopyable = Boolean((message.text && message.text.trim()) || (message.kind === "file" && message.file?.fileName));
    copyBtn.hidden = !hasCopyable;
  }

  const favBtn = document.querySelector("#msg-action-favorite");
  if (favBtn) {
    favBtn.textContent = translateText(message.isFavorite ? "Убрать из избранного" : "Добавить в избранное");
  }

  const deleteChoices = document.querySelector("#msg-action-delete-choices");
  const deleteBtn = document.querySelector("#msg-action-delete");
  const everyoneBtn = document.querySelector("#msg-action-delete-everyone");
  if (deleteChoices) deleteChoices.hidden = true;
  if (deleteBtn) deleteBtn.setAttribute("aria-expanded", "false");
  if (everyoneBtn) everyoneBtn.hidden = !canDeleteForEveryone(message);

  if (!dialog.open) dialog.showModal();
  document.querySelector("#message-actions-title")?.focus();
}

function renderDialogReactionButtons(message) {
  const row = document.querySelector("#message-actions-reactions");
  if (!row) return;
  row.replaceChildren();
  const activeSet = new Set(
    (message.reactions ?? []).filter((item) => item.reactedByMe).map((item) => item.emoji)
  );
  for (const choice of REACTION_CHOICES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reaction-picker-button";
    const pressed = activeSet.has(choice.emoji);
    btn.setAttribute("aria-pressed", String(pressed));
    btn.setAttribute("aria-label", `${translateText(choice.label)} ${choice.emoji}`);
    btn.textContent = choice.emoji;
    btn.addEventListener("click", () => {
      const target = actionMessage;
      closeMessageActionsDialog({ restoreFocus: true });
      if (target) void toggleMessageReaction(target, choice.emoji);
    });
    row.append(btn);
  }
}

function closeMessageActionsDialog({ restoreFocus = true } = {}) {
  const dialog = document.querySelector("#message-actions-dialog");
  actionMessage = null;
  if (dialog?.open) dialog.close();
  if (restoreFocus && actionReturnFocus instanceof HTMLElement && actionReturnFocus.isConnected) {
    actionReturnFocus.focus();
  }
  if (restoreFocus) actionReturnFocus = null;
}

async function copyMessageText(message) {
  const textToCopy = (message.text && message.text.trim())
    ? message.text
    : (message.kind === "file" && message.file?.fileName ? message.file.fileName : "");
  if (!textToCopy) {
    closeMessageActionsDialog({ restoreFocus: true });
    return;
  }
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(textToCopy);
      copied = true;
    }
  } catch { /* Fallback below. */ }
  if (!copied) {
    try {
      const host = document.querySelector("#message-actions-dialog")?.open
        ? document.querySelector("#message-actions-dialog")
        : document.body;
      const temp = document.createElement("textarea");
      temp.value = textToCopy;
      temp.setAttribute("readonly", "");
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      host.append(temp);
      temp.select();
      copied = document.execCommand("copy");
      temp.remove();
    } catch { copied = false; }
  }
  closeMessageActionsDialog({ restoreFocus: true });
  announce(copied ? "Текст сообщения скопирован." : "Не удалось скопировать текст сообщения.");
}

async function toggleMessageReaction(message, emoji) {
  if (!account || !selectedChat || !message || message.localState) return;
  const conversationId = message.conversationId || selectedChat.conversationId;
  try {
    const result = await api(`/api/v1/chats/${conversationId}/messages/${message.messageId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji })
    });
    const local = messages.find((candidate) => candidate.messageId === message.messageId);
    if (local && Array.isArray(result.reactions)) {
      local.reactions = result.reactions;
      renderMessages({ preserveVoicePlayback: true });
    }
    announce(result.added ? `Реакция ${emoji} поставлена.` : `Реакция ${emoji} убрана.`);
  } catch (error) {
    announce(`Не удалось обновить реакцию: ${error.message}`);
  }
}

async function toggleFavoriteMessage(message) {
  if (!account || !selectedChat || !message || message.localState) return;
  const conversationId = message.conversationId || selectedChat.conversationId;
  const adding = !message.isFavorite;
  try {
    await api(`/api/v1/chats/${conversationId}/messages/${message.messageId}/favorite`, {
      method: adding ? "POST" : "DELETE"
    });
    const local = messages.find((candidate) => candidate.messageId === message.messageId);
    if (local) {
      local.isFavorite = adding;
      renderMessages({ preserveVoicePlayback: true });
    }
    announce(adding ? "Сообщение добавлено в избранное." : "Сообщение убрано из избранного.");
  } catch (error) {
    announce(`Не удалось обновить избранное: ${error.message}`);
  }
}

async function deleteMessageWithScope(message, scope) {
  if (!account || !selectedChat || !message || message.localState) return;
  const conversationId = message.conversationId || selectedChat.conversationId;
  try {
    await api(`/api/v1/chats/${conversationId}/messages/${message.messageId}?scope=${encodeURIComponent(scope)}`, {
      method: "DELETE"
    });
    applyMessageRemovedLocally(conversationId, message.messageId);
    announce(scope === "everyone" ? "Сообщение удалено у всех." : "Сообщение удалено у вас.");
    await loadChats({ quiet: true });
  } catch (error) {
    announce(`Не удалось удалить сообщение: ${error.message}`);
  }
}

function applyMessageRemovedLocally(conversationId, messageId) {
  if (selectedChat?.conversationId === conversationId) {
    messages = messages.filter((candidate) => candidate.messageId !== messageId);
    for (const candidate of messages) {
      if (candidate.replyToMessageId === messageId || candidate.replyTo?.messageId === messageId) {
        candidate.replyTo = {
          messageId,
          senderUserId: null,
          senderDisplayName: "",
          kind: "text",
          text: translateText("Сообщение удалено"),
          deleted: true
        };
      }
    }
    if (replyTarget?.messageId === messageId) clearReplyTarget();
    if (editTarget?.messageId === messageId) clearEditTarget({ restoreDraft: true });
    if (actionMessage?.messageId === messageId) closeMessageActionsDialog({ restoreFocus: false });
    renderMessages({ preserveVoicePlayback: true });
  }
  const favDialog = document.querySelector("#favorites-dialog");
  if (favDialog?.open) void loadFavoritesIntoDialog();
}

function openForwardDialog(message) {
  const dialog = document.querySelector("#forward-dialog");
  if (!dialog || !message) return;
  forwardSourceMessage = message;
  const preview = document.querySelector("#forward-dialog-preview");
  if (preview) preview.textContent = messageSnippetText(message);
  const filter = document.querySelector("#forward-chat-filter");
  if (filter) filter.value = "";
  const status = document.querySelector("#forward-dialog-status");
  if (status) status.textContent = "";
  renderForwardChatList();
  dialog.showModal();
  document.querySelector("#forward-dialog-title")?.focus();
}

function renderForwardChatList() {
  const list = document.querySelector("#forward-chat-list");
  if (!list) return;
  list.replaceChildren();
  const q = (document.querySelector("#forward-chat-filter")?.value ?? "").trim().toLocaleLowerCase();
  const visibleChats = chats.filter((chat) => {
    const title = chat.kind === "group" ? chat.title : `${chat.peer?.displayName ?? ""} @${chat.peer?.username ?? ""}`;
    return !q || title.toLocaleLowerCase().includes(q);
  });
  if (!visibleChats.length) {
    const li = document.createElement("li");
    li.textContent = translateText("Чаты не найдены.");
    list.append(li);
    return;
  }
  for (const chat of visibleChats) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "user-result";
    const title = chat.kind === "group" ? chat.title : chat.peer.displayName;
    const sub = chat.kind === "group"
      ? `${chat.members?.length ?? 0} ${translateText("участников")}`
      : `@${chat.peer.username}`;
    const strong = document.createElement("strong");
    strong.dataset.userContent = "true";
    strong.textContent = title;
    const meta = document.createElement("span");
    meta.className = "chat-username";
    meta.dataset.userContent = "true";
    meta.textContent = sub;
    btn.append(strong, meta);
    btn.setAttribute("aria-label", `${translateText("Переслать в чат")} ${title}`);
    btn.addEventListener("click", () => void executeForwardToChat(chat));
    li.append(btn);
    list.append(li);
  }
}

async function executeForwardToChat(targetChat) {
  if (!forwardSourceMessage || !account) return;
  const source = forwardSourceMessage;
  const status = document.querySelector("#forward-dialog-status");
  if (status) status.textContent = translateText("Пересылаем сообщение…");
  try {
    const result = await api(`/api/v1/chats/${targetChat.conversationId}/messages/forward`, {
      method: "POST",
      body: JSON.stringify({
        sourceConversationId: source.conversationId || selectedChat?.conversationId,
        sourceMessageId: source.messageId,
        clientMessageId: randomId()
      })
    });
    forwardSourceMessage = null;
    document.querySelector("#forward-dialog")?.close();
    if (selectedChat?.conversationId === targetChat.conversationId && result.message) {
      upsertServerMessage(result.message);
    }
    const targetName = targetChat.kind === "group" ? targetChat.title : targetChat.peer.displayName;
    announce(`Сообщение переслано в чат ${targetName}.`);
    await loadChats({ quiet: true });
  } catch (error) {
    if (status) status.textContent = `${translateText("Не удалось переслать сообщение")}: ${error.message}`;
  }
}

async function openFavoritesDialog() {
  const dialog = document.querySelector("#favorites-dialog");
  if (!dialog || !account) return;
  dialog.showModal();
  document.querySelector("#favorites-dialog-title")?.focus();
  await loadFavoritesIntoDialog();
}

async function loadFavoritesIntoDialog() {
  const list = document.querySelector("#favorites-list");
  const status = document.querySelector("#favorites-dialog-status");
  if (!list || !status) return;
  status.textContent = translateText("Загружаю избранное…");
  list.replaceChildren();
  try {
    const result = await api("/api/v1/favorites");
    favoritesItems = result.favorites ?? [];
    renderFavoritesList();
  } catch (error) {
    status.textContent = `${translateText("Не удалось загрузить избранное")}: ${error.message}`;
  }
}

function renderFavoritesList() {
  const list = document.querySelector("#favorites-list");
  const status = document.querySelector("#favorites-dialog-status");
  if (!list || !status) return;
  list.replaceChildren();
  if (!favoritesItems.length) {
    status.textContent = translateText("В избранном пока нет сообщений. Откройте меню действий любого сообщения и выберите «Добавить в избранное».");
    return;
  }
  status.textContent = `${translateText("Сохранено сообщений")}: ${favoritesItems.length}`;
  for (const entry of favoritesItems) {
    const li = document.createElement("li");
    li.className = "favorite-item";

    const head = document.createElement("div");
    head.className = "favorite-item-head";
    const title = document.createElement("strong");
    title.dataset.userContent = "true";
    const chatLabel = entry.chatTitle || translateText("Чат");
    const senderLabel = entry.senderDisplayName || translateText("Участник");
    title.textContent = chatLabel === senderLabel ? chatLabel : `${chatLabel} · ${senderLabel}`;
    const time = document.createElement("time");
    time.textContent = `${dayLabel(entry.createdAt)}, ${messageTime(entry.createdAt)}`;
    head.append(title, time);

    const body = document.createElement("p");
    body.className = "favorite-item-text";
    body.dataset.userContent = "true";
    if (entry.text?.trim()) {
      renderLinkifiedText(body, entry.text);
    } else {
      body.textContent = entry.kind === "voice"
        ? translateText("Голосовое сообщение")
        : entry.fileName
          ? `${translateText("Файл")}: ${entry.fileName}`
          : translateText("Сообщение");
    }

    const actions = document.createElement("div");
    actions.className = "favorite-item-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = translateText("Открыть в чате");
    openBtn.addEventListener("click", () => void openFavoriteInChat(entry));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger-button";
    removeBtn.textContent = translateText("Убрать из избранного");
    removeBtn.addEventListener("click", () => void removeFavoriteEntry(entry));

    actions.append(openBtn, removeBtn);
    li.append(head, body, actions);
    list.append(li);
  }
}

async function openFavoriteInChat(entry) {
  document.querySelector("#favorites-dialog")?.close();
  let chat = chats.find((candidate) => candidate.conversationId === entry.conversationId);
  if (!chat) {
    await loadChats({ quiet: true });
    chat = chats.find((candidate) => candidate.conversationId === entry.conversationId);
  }
  if (!chat) {
    announce("Чат больше недоступен.");
    return;
  }
  if (selectedChat?.conversationId !== chat.conversationId) {
    await selectChat(chat, { focusHeading: false });
  }
  jumpToMessageById(entry.messageId);
}

async function removeFavoriteEntry(entry) {
  try {
    await api(`/api/v1/chats/${entry.conversationId}/messages/${entry.messageId}/favorite`, {
      method: "DELETE"
    });
    favoritesItems = favoritesItems.filter((item) => item.messageId !== entry.messageId);
    renderFavoritesList();
    if (selectedChat?.conversationId === entry.conversationId) {
      const local = messages.find((candidate) => candidate.messageId === entry.messageId);
      if (local) {
        local.isFavorite = false;
        renderMessages({ preserveVoicePlayback: true });
      }
    }
    announce("Сообщение убрано из избранного.");
  } catch (error) {
    announce(`Не удалось обновить избранное: ${error.message}`);
  }
}

function jumpToMessageById(messageId) {
  if (!messageId) return;
  const targetEl = [...elements.messageList.querySelectorAll(".message[data-message-id]")]
    .find((node) => node.dataset.messageId === messageId);
  if (!targetEl) {
    announce("Исходное сообщение недоступно.");
    return;
  }
  targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
  targetEl.classList.remove("message-highlight");
  void targetEl.offsetWidth;
  targetEl.classList.add("message-highlight");
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => targetEl.classList.remove("message-highlight"), 1800);
  targetEl.tabIndex = -1;
  targetEl.focus({ preventScroll: true });
  announce("Переход к исходному сообщению.");
}

function handleRealtimeMessageEdited(payload) {
  if (!payload?.message) return;
  applyMessageEditedLocally(payload.message);
  void loadChats({ quiet: true });
}

function handleRealtimeMessageDeleted(payload) {
  applyMessageRemovedLocally(payload.conversationId, payload.messageId);
  void loadChats({ quiet: true });
}

function handleRealtimeReactionsUpdated(payload) {
  if (selectedChat?.conversationId !== payload.conversationId) return;
  const local = messages.find((candidate) => candidate.messageId === payload.messageId);
  if (!local || !Array.isArray(payload.reactions)) return;
  local.reactions = payload.reactions.map((entry) => ({
    emoji: entry.emoji,
    count: entry.count,
    reactedByMe: Array.isArray(entry.userIds)
      ? entry.userIds.includes(account?.userId)
      : Boolean(entry.reactedByMe)
  }));
  renderMessages({ preserveVoicePlayback: true });
  if (actionMessage?.messageId === payload.messageId && document.querySelector("#message-actions-dialog")?.open) {
    renderDialogReactionButtons(local);
  }
}

function handleRealtimeFavoritesUpdated(payload) {
  if (selectedChat?.conversationId === payload.conversationId) {
    const local = messages.find((candidate) => candidate.messageId === payload.messageId);
    if (local) {
      local.isFavorite = Boolean(payload.isFavorite);
      renderMessages({ preserveVoicePlayback: true });
    }
  }
  if (document.querySelector("#favorites-dialog")?.open) {
    void loadFavoritesIntoDialog();
  }
}
