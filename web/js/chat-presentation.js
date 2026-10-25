import { language, translateText } from "./i18n.js";

// Presentation-only helpers. Chats, message delivery and server state remain separate.
function dateLocale(){ return language()==="be"?"be-BY":"ru-RU"; }
function dateFormat(options){return new Intl.DateTimeFormat(dateLocale(),options);}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function dayKey(value) {
  const date = validDate(value);
  if (!date) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function isYesterday(date, now) {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return dayKey(date) === dayKey(yesterday);
}

export function dayLabel(value, now = new Date()) {
  const date = validDate(value);
  if (!date) return translateText("Дата неизвестна");
  if (dayKey(date) === dayKey(now)) return translateText("Сегодня");
  if (isYesterday(date, now)) return translateText("Вчера");
  return dateFormat({day:"numeric",month:"long",year:"numeric"}).format(date);
}

export function chatTimeLabel(value, now = new Date()) {
  const date = validDate(value);
  if (!date) return "";
  if (dayKey(date) === dayKey(now)) return dateFormat({hour:"2-digit",minute:"2-digit"}).format(date);
  if (isYesterday(date, now)) return translateText("вчера");
  if (date.getFullYear() === now.getFullYear()) return dateFormat({day:"numeric",month:"short"}).format(date);
  return dateFormat({day:"numeric",month:"numeric",year:"2-digit"}).format(date);
}

export function messageTime(value) {
  const date = validDate(value);
  return date ? dateFormat({hour:"2-digit",minute:"2-digit"}).format(date) : "";
}

export function chatPreview(lastMessage, ownUserId) {
  if (!lastMessage) return translateText("Начните переписку");
  const prefix = lastMessage.senderUserId === ownUserId ? "Вы: " : "";
  if (lastMessage.kind === "voice") return prefix + translateText("Голосовое сообщение");
  if (typeof lastMessage.text === "string" && lastMessage.text.startsWith("bmsec1:")) return prefix + translateText("Сообщение");
  const text = String(lastMessage.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return prefix + translateText("Сообщение");
  return prefix + (text.length > 80 ? `${text.slice(0, 77)}…` : text);
}


export function messageDeliveryState(message, ownUserId) {
  if (!message || message.senderUserId !== ownUserId) return "";
  if (message.readAt) return translateText("прочитано");
  if (message.deliveredAt) return translateText("доставлено");
  return translateText("отправлено");
}

export function chatAccessibleLabel(chat, ownUserId, now = new Date()) {
  const name = chat.peer?.displayName || translateText("Собеседник");
  const username = chat.peer?.username ? `@${chat.peer.username}` : "";
  const preview = chatPreview(chat.lastMessage, ownUserId);
  const time = chatTimeLabel(chat.lastMessage?.createdAt ?? chat.lastMessageAt, now);
  const state = messageDeliveryState(chat.lastMessage, ownUserId);
  return [name, username, preview, state, time, translateText("Открыть чат")].filter(Boolean).join(". ");
}

export function isNearBottom(element, tolerance = 90) {
  if (!element) return true;
  const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
  return !Number.isFinite(remaining) || remaining <= tolerance;
}
