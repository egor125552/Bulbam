import { badRequest } from "../../../core/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ALLOWED_REACTIONS = ["👍", "❤️", "🔥", "😂", "😮", "😢", "👏", "🙏"] as const;
const ALLOWED_REACTION_SET = new Set<string>(ALLOWED_REACTIONS);

export function validateUserId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    badRequest("invalid_user_id", "Некорректный идентификатор пользователя.");
  }
  return value;
}

export function validateConversationId(value: string): string {
  if (!UUID.test(value)) {
    badRequest("invalid_conversation_id", "Некорректный идентификатор диалога.");
  }
  return value;
}

export function validateMessageId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    badRequest("invalid_message_id", "Некорректный идентификатор сообщения.");
  }
  return value;
}

export function validateMessageInput(body: Record<string, unknown>) {
  const rawText = body.text;
  const rawClientMessageId = body.clientMessageId;
  const rawReplyTo = body.replyToMessageId;

  if (typeof rawText !== "string") {
    badRequest("invalid_message", "Текст сообщения обязателен.");
  }
  const text = rawText.replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 4000) {
    badRequest("invalid_message", "Сообщение должно содержать от 1 до 4000 символов.");
  }

  if (
    typeof rawClientMessageId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(rawClientMessageId)
  ) {
    badRequest("invalid_client_message_id", "Некорректный clientMessageId.");
  }

  let replyToMessageId: string | null = null;
  if (rawReplyTo !== undefined && rawReplyTo !== null && rawReplyTo !== "") {
    if (typeof rawReplyTo !== "string" || !UUID.test(rawReplyTo)) {
      badRequest("invalid_reply_message_id", "Некорректный идентификатор сообщения для ответа.");
    }
    replyToMessageId = rawReplyTo;
  }

  return { text, clientMessageId: rawClientMessageId, replyToMessageId };
}

export function validateMessageEditInput(body: Record<string, unknown>) {
  const rawText = body.text;
  if (typeof rawText !== "string") {
    badRequest("invalid_message", "Текст сообщения обязателен.");
  }
  const text = rawText.replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 4000) {
    badRequest("invalid_message", "Сообщение должно содержать от 1 до 4000 символов.");
  }
  return { text };
}

export function validateDeleteScope(value: unknown): "me" | "everyone" {
  if (value === "me" || value === "everyone") return value;
  badRequest("invalid_delete_scope", "Укажите способ удаления: у себя или у всех.");
}

export function validateReactionEmoji(value: unknown): string {
  if (typeof value !== "string" || !ALLOWED_REACTION_SET.has(value)) {
    badRequest("invalid_reaction", "Выберите доступную реакцию.");
  }
  return value;
}

export function validateForwardInput(body: Record<string, unknown>) {
  const sourceConversationId = validateConversationId(String(body.sourceConversationId ?? ""));
  const sourceMessageId = validateMessageId(body.sourceMessageId);
  const rawClientMessageId = body.clientMessageId;
  if (
    typeof rawClientMessageId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(rawClientMessageId)
  ) {
    badRequest("invalid_client_message_id", "Некорректный clientMessageId.");
  }
  return { sourceConversationId, sourceMessageId, clientMessageId: rawClientMessageId };
}

export function validateDeliveryReceiptInput(body: Record<string, unknown>): string[] {
  const rawMessageIds = body.messageIds;
  if (!Array.isArray(rawMessageIds) || rawMessageIds.length < 1 || rawMessageIds.length > 100) {
    badRequest("invalid_delivery_receipt", "Нужно передать от 1 до 100 идентификаторов сообщений.");
  }

  const messageIds = [...new Set(rawMessageIds)];
  if (messageIds.some((messageId) => typeof messageId !== "string" || !UUID.test(messageId))) {
    badRequest("invalid_delivery_receipt", "Некорректный идентификатор сообщения.");
  }

  return messageIds as string[];
}
