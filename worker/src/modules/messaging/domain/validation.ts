import { badRequest } from "../../../core/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function validateMessageInput(body: Record<string, unknown>) {
  const rawText = body.text;
  const rawClientMessageId = body.clientMessageId;

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

  return { text, clientMessageId: rawClientMessageId };
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
