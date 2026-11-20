import { logDiagnostic, logTraceEvent, diagnosticErrorName } from "./diagnostics-log.js";
import { translateText } from "./i18n.js";
import { api } from "./api.js";
import { subscribeRealtime, reconnectRealtime } from "./shared-realtime.js";
import { createPendingMessageOutbox, isDisplayedConversation } from "./pending-message-outbox.js";
import { takeRequestedChat } from "./chat-deeplink.js";
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
const queuedMessages=createPendingMessageOutbox();
let nextHistoryCursor=null;
let loadingOlder=false;
let historyButton=null;
let searchTimer = null;
let unsubscribeRealtime=null;
let pollTimer = null;
let generation = 0;
let jumpButton = null;
let presenceByUserId = new Map();
let groupCandidates=new Map();
let groupSelected=new Set();
let groupEditorMode='create';
let groupEditorConversation=null;
let groupSearchTimer=null;
let pendingNotificationChat=null;

export function setupMessenger() {
  jumpButton = document.querySelector("#jump-to-latest");
  historyButton=document.createElement("button");
  historyButton.type="button";
  historyButton.textContent="Загрузить предыдущие сообщения";
  historyButton.hidden=true;
  historyButton.addEventListener("click",()=>void loadOlderMessages());
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
  window.addEventListener("bulbam:notification-open",event=>{
    const url=event.detail?.url;
    if(typeof url!=="string" || !account)return;
    const target=new URL(url,location.origin);
    if(target.origin!==location.origin || !target.searchParams.has("chat"))return;
    const chatId=target.searchParams.get("chat");
    if(!/^[0-9a-f-]{36}$/i.test(chatId??""))return;
    // Protect an active recording and any unsent text in the composer.
    if(document.body.classList.contains("voice-recording") ||
       (elements.messageInput.value.trim() && selectedChat?.conversationId!==chatId)){
      pendingNotificationChat=chatId;
      announce("Открою новый чат, когда вы завершите запись или отправите текст.");
      return;
    }
    void openNotificationChat(chatId);
  });
  window.addEventListener("bulbam:voice-recording-finished",maybeOpenPendingNotification);
  elements.messageInput.addEventListener("input",maybeOpenPendingNotification);
  window.addEventListener("bulbam:profile-updated",event=>{
    if(account?.userId===event.detail?.account?.userId)
      account={...account,displayName:event.detail.account.displayName};
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
    void refreshVisibleState().then(openRequestedChat);
    reconnectRealtime();
  });
  window.addEventListener("focus",()=>{if(account)void openRequestedChat();});
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
  pendingNotificationChat=null;
  account = nextAccount;
  logTraceEvent('Навигация','смена пользователя','',{active:Boolean(nextAccount)});
  chats = [];
  presenceByUserId.clear();
  selectedChat = null;
  messages = [];
  queuedMessages.clear();
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
  await openRequestedChat();
  connectRealtime();
}

function maybeOpenPendingNotification(){
  if(!pendingNotificationChat || document.body.classList.contains("voice-recording") ||
     elements.messageInput.value.trim())return;
  const id=pendingNotificationChat;
  pendingNotificationChat=null;
  void openNotificationChat(id);
}

async function openNotificationChat(id){
  if(!account)return;
  let chat=chats.find(item=>item.conversationId===id);
  if(!chat){
    await loadChats({quiet:true});
    chat=chats.find(item=>item.conversationId===id);
  }
  if(chat && account)await selectChat(chat,{focusHeading:true});
}

async function openRequestedChat() {
  if(!account || typeof location==="undefined")return;
  const id=takeRequestedChat(location.href,address=>history.replaceState(null,"",address));
  if(!id)return;
  let chat=chats.find(item=>item.conversationId===id);
  if(!chat) {
    await loadChats({quiet:true});
    chat=chats.find(item=>item.conversationId===id);
  }
  if(chat)await selectChat(chat,{focusHeading:true});
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
    const latestPreview=chatPreview(chat.lastMessage,account.userId);
    button.dataset.searchPreview=latestPreview;
    preview.textContent=[latestPreview,deliveryState].filter(Boolean).join(" · ");

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
  nextHistoryCursor=null;
  if(historyButton)historyButton.hidden=true;
  if (jumpButton) jumpButton.hidden = true;
  messages = [...(queuedMessages.forConversation(chat.conversationId))];
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
    const hasLoadedOlder=messages.some(message=>!message.localState &&
      serverMessages.length && (message.createdAt<serverMessages[0].createdAt ||
        (message.createdAt===serverMessages[0].createdAt && message.messageId<serverMessages[0].messageId)));
    if(!hasLoadedOlder)nextHistoryCursor=result.hasMore && serverMessages.length
      ? `${serverMessages[0].createdAt}_${serverMessages[0].messageId}` : null;
    logTraceEvent('Сервер','история чата загружена','',{messages:serverMessages.length});
    const pending = [...(queuedMessages.forConversation(conversationId))];
    messages = hasLoadedOlder
      ? [...new Map([...messages.filter(message=>!message.localState),...serverMessages]
        .map(message=>[message.messageId,message])).values()]
      : serverMessages;
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

async function loadOlderMessages(){
  if(!selectedChat || !nextHistoryCursor || loadingOlder)return;
  const id=selectedChat.conversationId,cursor=nextHistoryCursor;
  loadingOlder=true;
  if(historyButton)historyButton.disabled=true;
  const list=elements.messageList;
  const height=list.scrollHeight,top=list.scrollTop;
  try {
    const result=await api(`/api/v1/chats/${id}/messages?before=${encodeURIComponent(cursor)}`);
    if(selectedChat?.conversationId!==id)return;
    const older=result.messages??[];
    const byId=new Map([...older,...messages].map(message=>[message.messageId,message]));
    messages=[...byId.values()];
    nextHistoryCursor=result.hasMore && older.length
      ? `${older[0].createdAt}_${older[0].messageId}` : null;
    renderMessages({preserveVoicePlayback:true});
    list.scrollTop=top+(list.scrollHeight-height);
    if(historyButton && !historyButton.hidden)historyButton.focus({preventScroll:true});
    else {
      const first=list.querySelector(".message");
      if(first){first.tabIndex=-1;first.focus({preventScroll:true});}
    }
  }catch(error){announce(`Не удалось загрузить предыдущие сообщения: ${error.message}`);}
  finally{loadingOlder=false;if(historyButton)historyButton.disabled=false;}
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
  if(historyButton) {
    historyButton.hidden=!nextHistoryCursor;
    if(nextHistoryCursor) {
      const wrapper=document.createElement("li");
      wrapper.append(historyButton);
      list.append(wrapper);
    }
  }

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
  queuedMessages.add(pending);
  messages.push(pending);
  logTraceEvent('Интерфейс','сообщение поставлено в очередь','',{count:messages.length});
  elements.messageInput.value = "";
  // The outgoing message is already pinned to its original conversation.
  maybeOpenPendingNotification();
  renderMessages({ preserveVoicePlayback: true, scrollToBottom: true });
  await transmitPending(pending);
}

async function transmitPending(pending) {
  if (!account) return;
  const sendingUserId=account.userId;
  pending.localState = "pending";
  logDiagnostic('Сеть','повтор или начало отправки текста');
  if(isDisplayedConversation(selectedChat,pending))renderMessages({ preserveVoicePlayback: true });
  try {
    const result = await api(`/api/v1/chats/${pending.conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        clientMessageId: pending.clientMessageId,
        text: pending.text
      })
    });
    if(account?.userId!==sendingUserId)return;
    queuedMessages.remove(pending);
    if(isDisplayedConversation(selectedChat,pending))upsertServerMessage(result.message);
    logDiagnostic('Сеть','сообщение подтверждено сервером');
    announce("Сообщение отправлено.");
    await loadChats({ quiet: true });
  } catch (error) {
    if(account?.userId!==sendingUserId)return;
    pending.localState = "failed";
    logDiagnostic('Ошибки','сообщение не отправлено',diagnosticErrorName(error));
    if(isDisplayedConversation(selectedChat,pending))renderMessages({ preserveVoicePlayback: true });
    announce(`Сообщение не отправлено: ${error.message}. Можно повторить отправку.`);
  }
}

function upsertServerMessage(message) {
  if(!isDisplayedConversation(selectedChat,message))return;
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
  if(!account || unsubscribeRealtime)return;
  unsubscribeRealtime=subscribeRealtime(account.userId,{
    open(){stopPolling();logDiagnostic("Сеть","сокет сообщений подключён");},
    close(){if(account)startPolling();},
    message(payload){
    const known=['message.created','messages.delivered','messages.read','voice.progress','chat.created','chat.updated','chat.removed'];
    logDiagnostic('Сеть','получено событие сокета',known.includes(payload?.type)?payload.type:'другое');
    if (payload?.type === "message.created" && payload.message) {
      logDiagnostic("Сервер", "событие новое сообщение");
      handleRealtimeMessage(payload);
    } else if(payload?.type==='chat.removed'){
      if(selectedChat?.conversationId===payload.conversationId){selectedChat=null;messages=[];renderConversation();}
      void loadChats({quiet:true});
    } else if(payload?.type==="chat.profile-updated") {
      const {userId,displayName}=payload;
      if(typeof displayName!=="string" || !userId)return;
      for(const chat of chats){
        if(chat.peer?.userId===userId)chat.peer.displayName=displayName;
        for(const member of chat.members??[])if(member.userId===userId)member.displayName=displayName;
      }
      if(selectedChat){
        elements.conversationTitle.textContent=selectedChat.kind==="group"?selectedChat.title:selectedChat.peer.displayName;
        renderMessages({preserveVoicePlayback:true});
      }
      renderChats();
      updatePeerPresence();
    } else if(payload?.type==='chat.created'||payload?.type==='chat.updated'){
      void loadChats({quiet:true});
    } else if ((payload?.type === "messages.delivered" || payload?.type === "messages.read") && Array.isArray(payload.receipts)) {
      handleDeliveredReceipts(payload);
    } else if (payload?.type === "voice.progress" && payload.messageId && payload.progress) {
      handleVoiceProgress(payload);
    }
  }
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
    const author=chat?.kind==='group'
      ? chat.members?.find(member=>member.userId===payload.message.senderUserId)?.displayName??'участника'
      :chat?.peer?.displayName??'собеседника';
    announce(chat?.kind==='group'?`Новое сообщение в группе ${chat.title} от ${author}.`:`Новое сообщение от ${author}.`);
  }
}

function handleVoiceProgress(payload) {
  if (selectedChat?.conversationId !== payload.conversationId) return;
  const message = messages.find((candidate) => candidate.messageId === payload.messageId);
  if(message?.voice && !(message.voice.progress?.completedAt && !payload.progress.completedAt))
    message.voice.progress=payload.progress;
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

function stopRealtime(){
  unsubscribeRealtime?.();
  unsubscribeRealtime=null;
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
  document.querySelector('#group-members-delete')?.addEventListener('click',()=>void manageOwnGroup('delete'));
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
  document.querySelector('#group-members-delete').hidden=selectedChat.ownerUserId!==account?.userId;
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
    if(owner && member.userId!==account?.userId){
      const transfer=document.createElement("button");transfer.type="button";
      transfer.textContent="Передать права и выйти";
      transfer.setAttribute("aria-label",`Передать права ${member.displayName} и выйти из группы`);
      transfer.addEventListener("click",()=>void manageOwnGroup("transfer",member.userId));
      li.append(transfer);
    }
    list.append(li);
  }
}

async function manageOwnGroup(action,newOwnerUserId){
  if(selectedChat?.kind!=="group"||selectedChat.ownerUserId!==account?.userId)return;
  const id=selectedChat.conversationId;
  const prompt=action==="delete"
    ?"Удалить группу для всех участников вместе с историей сообщений?"
    :"Передать права выбранному участнику и выйти из группы?";
  if(!window.confirm(prompt))return;
  try{
    await api(`/api/v1/chats/${id}/group-actions`,{
      method:"POST",body:JSON.stringify({action,newOwnerUserId})
    });
    document.querySelector("#group-members-dialog")?.close();
    if(selectedChat?.conversationId===id){
      selectedChat=null;messages=[];renderConversation();
    }
    await loadChats({quiet:true});
    announce(action==="delete"?"Группа удалена.":"Права переданы. Вы вышли из группы.");
  }catch(error){announce(`Не удалось изменить группу: ${error.message}`);}
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
