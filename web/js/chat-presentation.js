// Presentation-only helpers. Chats, message delivery and server state remain separate.
const shortDate = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" });
const fullDate = new Intl.DateTimeFormat("ru", { day: "numeric", month: "long", year: "numeric" });
const clock = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" });

function validDate(value) {
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
  if (!date) return "Дата неизвестна";
  if (dayKey(date) === dayKey(now)) return "Сегодня";
  if (isYesterday(date, now)) return "Вчера";
  return fullDate.format(date);
}

export function chatTimeLabel(value, now = new Date()) {
  const date = validDate(value);
  if (!date) return "";
  if (dayKey(date) === dayKey(now)) return clock.format(date);
  if (isYesterday(date, now)) return "вчера";
  if (date.getFullYear() === now.getFullYear()) return shortDate.format(date);
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "numeric", year: "2-digit" }).format(date);
}

export function messageTime(value) {
  const date = validDate(value);
  return date ? clock.format(date) : "";
}

export function chatPreview(lastMessage, ownUserId) {
  if (!lastMessage) return "Начните переписку";
  const prefix = lastMessage.senderUserId === ownUserId ? "Вы: " : "";
  if (lastMessage.kind === "voice") return prefix + "Голосовое сообщение";
  if (typeof lastMessage.text === "string" && lastMessage.text.startsWith("bmsec1:")) return prefix + "Защищённое сообщение";
  const text = String(lastMessage.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return prefix + "Сообщение";
  return prefix + (text.length > 80 ? `${text.slice(0, 77)}…` : text);
}

export function chatAccessibleLabel(chat, ownUserId, now = new Date()) {
  const name = chat.peer?.displayName || "Собеседник";
  const username = chat.peer?.username ? `@${chat.peer.username}` : "";
  const preview = chatPreview(chat.lastMessage, ownUserId);
  const time = chatTimeLabel(chat.lastMessage?.createdAt ?? chat.lastMessageAt, now);
  return [name, username, preview, time, "Открыть чат"].filter(Boolean).join(". ");
}

export function isNearBottom(element, tolerance = 90) {
  if (!element) return true;
  const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
  return !Number.isFinite(remaining) || remaining <= tolerance;
}
