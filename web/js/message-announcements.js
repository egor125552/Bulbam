import { observeApiResponses } from "./api.js";
import { findNewIncomingMessages } from "./message-announcement-core.js";
import { announce, getCurrentAccount } from "./ui.js";

const MESSAGES_PATH = /^\/api\/v1\/chats\/([0-9a-f-]{36})\/messages$/i;
const knownByConversation = new Map();
let currentConversationId = null;
let messageList = null;

export function setupMessageAnnouncements() {
  observeApiResponses(handleApiResponse);

  window.addEventListener("bulbam:account-changed", () => {
    knownByConversation.clear();
    currentConversationId = null;
  });
  window.addEventListener("bulbam:chat-changed", (event) => {
    currentConversationId = event.detail?.chat?.conversationId ?? null;
  });

  messageList = document.querySelector("#message-list");
  if (!(messageList instanceof HTMLElement) || !window.MutationObserver) return;
  const observer = new MutationObserver(rememberVisibleMessageIds);
  observer.observe(messageList, { childList: true, subtree: false });
}

function handleApiResponse({ path, method, payload }) {
  if (method !== "GET") return;
  const match = String(path).match(MESSAGES_PATH);
  if (!match || !Array.isArray(payload?.messages)) return;

  const conversationId = match[1];
  const serverMessages = payload.messages;
  const known = knownByConversation.get(conversationId);

  // The first history load is context, not a burst of new-message alerts. Even an
  // empty first history is recorded so the very next polling discovery is announced.
  if (!known) {
    knownByConversation.set(
      conversationId,
      new Set(serverMessages.map((message) => message?.messageId).filter(Boolean))
    );
    return;
  }

  const accountId = getCurrentAccount()?.userId ?? null;
  const incoming = findNewIncomingMessages(known, serverMessages, accountId);
  for (const message of serverMessages) {
    if (message?.messageId) known.add(message.messageId);
  }

  if (!incoming.length || conversationId !== currentConversationId) return;
  const peerName = document.querySelector("#conversation-title")?.textContent?.trim() || "собеседника";
  announce(incoming.length === 1
    ? `Новое сообщение от ${peerName}.`
    : `Новых сообщений от ${peerName}: ${incoming.length}.`);
}

function rememberVisibleMessageIds() {
  if (!currentConversationId || !messageList) return;
  const known = knownByConversation.get(currentConversationId);
  // Do not create the set from DOM. The first successful GET /messages must seed it,
  // otherwise a realtime message racing the initial history request could make old
  // history look new when that first response arrives.
  if (!known) return;
  for (const item of messageList.querySelectorAll(".message[data-message-id]")) {
    const messageId = item.getAttribute("data-message-id");
    if (messageId && !messageId.startsWith("pending_")) known.add(messageId);
  }
}
