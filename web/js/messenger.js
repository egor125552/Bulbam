import { logDiagnostic, logTraceEvent, diagnosticErrorName } from "./diagnostics-log.js";
import { translateText } from "./i18n.js";
import { api } from "./api.js";
import { decryptText, encryptText, importConversationSecret, isEncryptedText } from "./secure-messages.js";
import { decryptVoiceFile } from "./secure-voice.js";
import { getSecureChatState, requireProtectedConversationKey, setSecureConversation, setupSecureChat } from "./secure-chat-ui.js";
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
let groupCandidates=new Map();
let groupSelected=new Set();
let groupEditorMode='create';
let groupEditorConversation=null;
let groupSearchTimer=null;

export function setupMessenger() {
  setupSecureChat({
    onKeyChanged: () => {renderMessages({ preserveVoicePlayback: true });void loadChats({quiet:true});},
    verifyCandidateKey: async (secret, candidateAccountId, candidateConversationId) => {
      if (account?.userId !== candidateAccountId ||
          selectedChat?.conversationId !== candidateConversationId) {
        throw new Error("Переписка изменилась во время проверки ключа.");
      }
      const sample = messages.find((message) =>
        message.conversationId === candidateConversationId && isProtectedContent(message));
      if (!sample) return;
      const key = await importConversationSecret(secret);
      try {
        const context = {
          conversationId: sample.conversationId,
          senderUserId: sample.senderUserId,
          clientMessageId: sample.clientMessageId
        };
        if (isEncryptedText(sample.text)) {
          await decryptText(sample.text, key, context);
        } else if (sample.voice?.mimeType?.startsWith("application/vnd.bulbam.encrypted-voice")) {
          // A conversation containing only protected voice must also reject a
          // wrong key BEFORE it becomes the non-replaceable device key.
          const response = await fetch(
            `/api/v1/chats/${sample.conversationId}/messages/${sample.messageId}/voice/audio`,
            { credentials: "same-origin", cache: "no-store" }
          );
          if (!response.ok) throw new Error("Protected sample unavailable");
          await decryptVoiceFile(await response.blob(), key, sample.voice.mimeType, context);
        }
      } catch {
        throw new Error("Не удалось проверить ключ по защищённому сообщению. Проверьте код у собеседника.");
      }
    }
  });
  jumpButton = document.querySelector("#jump-to-latest");
  jumpButton?.addEventListener("click", jumpToLatest);
  elements.messageList.addEventListener("scroll", () => {
    if (jumpButton && isNearBottom(elements.messageList)) jumpButton.hidden = true;
  });
  elements.newChatButton.addEventListener("click", toggleSearchPanel);
  setupGroupEditor();
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
  void setSecureConversation(nextAccount, null);
  account = nextAccount;
  logTraceEvent('Навигация','смена пользователя','',{active:Boolean(nextAccount)});
  chats = [];
  presenceByUserId.clear();
  selectedChat = null;
  messages = [];
  resetVoicePlayers();
  stopRealtime();
  stopPolling();
  closeSearchPanel();
  document.querySelector('#group-editor')?.close?.();
  document.querySelector('#group-members-dialog')?.close?.();
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
      const prev=selectedChat;
      selectedChat = chats.find((chat) => chat.conversationId === selectedChat.conversationId) ?? selectedChat;
      if(prev.encryptionMode!==selectedChat.encryptionMode)
        void setSecureConversation(account,selectedChat);
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
  void setSecureConversation(account, chat);
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
    logTraceEvent('Сервер','история чата загружена','',{messages:serverMessages.length});
    requireProtectedConversationKey(account.userId, conversationId, serverMessages.some(isProtectedContent));
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
  elements.callStartButton.hidden=chat.kind==='group';
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
    author.textContent = mine ? "Вы" : selectedChat.kind==='group'
      ? selectedChat.members?.find(member=>member.userId===message.senderUserId)?.displayName??'Участник'
      : selectedChat.peer.displayName;
    if (!mine) author.dataset.userContent = "true";
    item.append(author);

    if (message.kind === "voice" && message.voice) {
      item.append(renderVoiceMessage(message, mine));
    } else {
      const body = document.createElement("p");
      if (isEncryptedText(message.text)) {
        body.textContent = "Защищённое сообщение. Для чтения нужен ключ этой переписки.";
        const current = getSecureChatState();
        if (current.key && current.conversationId === selectedChat.conversationId) {
          void decryptText(message.text, current.key, {
            conversationId: message.conversationId,
            senderUserId: message.senderUserId,
            clientMessageId: message.clientMessageId
          }).then((plaintext) => {
            if (item.isConnected && selectedChat?.conversationId === message.conversationId) {
              body.textContent = plaintext;
            }
          }).catch(() => {
            if (item.isConnected) body.textContent = "Не удалось расшифровать. Проверьте ключ переписки.";
          });
        }
      } else {
        body.textContent = message.text;
        if (getSecureChatState().key && !message.localState && message.kind === "text") {
          item.classList.add("message-unprotected");
          body.setAttribute("aria-label", "Без шифрования. " + message.text);
        }
      }
      body.dataset.userContent = "true";
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
    if (state && !(mine&&selectedChat.kind==='group')) {
      const stateLabel = document.createElement("span");
      stateLabel.textContent = ` · ${translateText(state)}`;
      meta.append(stateLabel);
    }
    let readersDetails=null;
    if(mine&&selectedChat.kind==='group'&&!message.localState){
      const readers=message.readBy??[];
      const total=Math.max(readers.length,message.eligibleRecipientCount??(selectedChat.members?.length??1)-1);
      const details=document.createElement('details');
      const summary=document.createElement('summary');
      summary.textContent=`Прочитали: ${readers.length} из ${total}`;
      const names=document.createElement('p');
      names.textContent=readers.length?readers.map(reader=>selectedChat.members?.find(member=>member.userId===reader.userId)?.displayName??'Участник').join(', '):'Пока никто не прочитал';
      details.append(summary,names);
      readersDetails=details;
    }
    item.append(meta);
    if(readersDetails)item.append(readersDetails);

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
  const secure = getSecureChatState();
  if (secure.blocked || secure.conversationId !== selectedChat.conversationId) {
    announce("Невозможно проверить ключ переписки. Сообщение не отправлено.");
    return;
  }
  if (!secure.key && (secure.requiresKey || messages.some(isProtectedContent))) {
    announce("В переписке есть защищённые сообщения. Введите ключ перед отправкой, чтобы не отправить текст открыто.");
    return;
  }
  const expectedChat = selectedChat.conversationId;
  const clientMessageId = randomId();
  let wireText = text;
  try {
    if (secure.key) wireText = await encryptText(text, secure.key, {
      conversationId: expectedChat, senderUserId: account.userId, clientMessageId
    });
  } catch (error) {
    announce("Сообщение не отправлено: " + error.message);
    return;
  }
  if (selectedChat?.conversationId !== expectedChat || account?.userId !== secure.accountId) return;

  const pending = {
    messageId: `pending_${randomId()}`,
    conversationId: selectedChat.conversationId,
    senderUserId: account.userId,
    clientMessageId,
    kind: "text",
    text,
    wireText,
    voice: null,
    createdAt: Date.now(),
    deliveredAt: null,
    localState: "pending"
  };
  messages.push(pending);
  logTraceEvent('Интерфейс','сообщение поставлено в очередь','',{count:messages.length});
  elements.messageInput.value = "";
  renderMessages({ preserveVoicePlayback: true, scrollToBottom: true });
  await transmitPending(pending);
}

async function transmitPending(pending) {
  if (!account || !selectedChat || pending.conversationId !== selectedChat.conversationId) return;
  const secure = getSecureChatState();
  if (secure.blocked || secure.conversationId !== pending.conversationId || secure.accountId !== account.userId) {
    announce("Сообщение осталось в черновике: ключ переписки пока недоступен.");
    return;
  }
  try {
    // Retrying a draft written before protection was enabled must never send it in the clear.
    if (secure.key && !isEncryptedText(pending.wireText ?? pending.text)) {
      pending.wireText = await encryptText(pending.text, secure.key, {
        conversationId: pending.conversationId,
        senderUserId: account.userId,
        clientMessageId: pending.clientMessageId
      });
    }
    if (!secure.key && isEncryptedText(pending.wireText ?? pending.text)) {
      announce("Нельзя повторить отправку, пока ключ переписки недоступен.");
      return;
    }
    if (!secure.key && (secure.requiresKey || messages.some(isProtectedContent))) {
      announce("Повторная отправка без ключа заблокирована.");
      return;
    }
  } catch (error) {
    announce("Не удалось защитить сообщение: " + error.message);
    return;
  }
  if (!account || selectedChat?.conversationId !== pending.conversationId ||
    getSecureChatState().key !== secure.key) return;
  pending.localState = "pending";
  logDiagnostic('Сеть','повтор или начало отправки текста');
  renderMessages({ preserveVoicePlayback: true });
  try {
    const result = await api(`/api/v1/chats/${pending.conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        clientMessageId: pending.clientMessageId,
        text: pending.wireText ?? pending.text
      })
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
  requireProtectedConversationKey(account?.userId, merged.conversationId, isProtectedContent(merged));
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
  if (!account || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  logDiagnostic('Сеть','начало подключения сокета сообщений');
  socket = new WebSocket(`${protocol}//${location.host}/api/v1/realtime`);

  socket.addEventListener("open", () => {
    logDiagnostic("Сеть", "сокет сообщений подключён");
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
    const known=['message.created','messages.delivered','messages.read','voice.progress','chat.created','chat.updated','chat.removed'];
    logDiagnostic('Сеть','получено событие сокета',known.includes(payload?.type)?payload.type:'другое');
    if (payload?.type === "message.created" && payload.message) {
      logDiagnostic("Сервер", "событие новое сообщение");
      handleRealtimeMessage(payload);
    } else if(payload?.type==='chat.removed'){
      if(selectedChat?.conversationId===payload.conversationId){selectedChat=null;messages=[];renderConversation();}
      void loadChats({quiet:true});
    } else if(payload?.type==='chat.created'||payload?.type==='chat.updated'){
      void loadChats({quiet:true});
    } else if ((payload?.type === "messages.delivered" || payload?.type === "messages.read") && Array.isArray(payload.receipts)) {
      handleDeliveredReceipts(payload);
    } else if (payload?.type === "voice.progress" && payload.messageId && payload.progress) {
      handleVoiceProgress(payload);
    }
  });

  socket.addEventListener("close", handleRealtimeDisconnect);
  socket.addEventListener("error", () => {
    logDiagnostic('Ошибки','ошибка сокета сообщений');
    try { socket?.close(); } catch {}
  });
}

function handleRealtimeMessage(payload) {
  const chat = chats.find((candidate) => candidate.conversationId === payload.conversationId);
  if (selectedChat?.conversationId === payload.conversationId) {
    requireProtectedConversationKey(account.userId,payload.conversationId,isProtectedContent(payload.message));
    upsertServerMessage(payload.message);
  }
  void loadChats({ quiet: true });

  if (payload.message.senderUserId !== account?.userId) {
    void acknowledgeIncomingMessages(payload.conversationId, [payload.message]);
    const author=chat?.kind==='group'
      ? chat.members?.find(member=>member.userId===payload.message.senderUserId)?.displayName??'участника'
      :chat?.peer?.displayName??'собеседника';
    announce(chat?.kind==='group'?`Новое сообщение в группе ${chat.title} от ${author}.`:`Новое сообщение от ${author}.`);
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

function handleRealtimeDisconnect() {
  logDiagnostic("Сеть", "сокет сообщений отключён");
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  socket = null;
  if (!account) return;
  startPolling();
  clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(15000, reconnectDelay * 2);
  logTraceEvent('Сеть','переподключение сокета назначено','',{retryMs:delay,step:reconnectDelay});
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
  logDiagnostic('Сеть','резервный опрос включен');
  pollTimer = setInterval(() => void refreshVisibleState(), 5000);
}

function stopPolling() {
  if(pollTimer)logDiagnostic('Сеть','резервный опрос остановлен');
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

function isProtectedContent(message) {
  return isEncryptedText(message?.text) ||
    Boolean(message?.voice?.mimeType?.startsWith("application/vnd.bulbam.encrypted-voice"));
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
