import { ApiError, badRequest, conflict, notFound } from "../../../core/errors";
import type { MessageNotificationPublisher } from "../../notifications/application/push-notification-service";
import type { DirectConversation, MessagingActor, StoredMessage, VoiceAttachment } from "../domain/models";
import {
  validateConversationId,
  validateDeliveryReceiptInput,
  validateMessageInput,
  validateUserId
} from "../domain/validation";
import type { MessagingRepository } from "../ports/messaging-repository";
import type { RealtimePublisher } from "../ports/realtime-publisher";
import type { DirectoryUser, UserDirectory } from "../ports/user-directory";

export interface PreparedVoiceMessage {
  messageId: string;
  clientMessageId: string;
  voice: Omit<VoiceAttachment, "progress">;
}

export class MessagingService {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly users: UserDirectory,
    private readonly realtime: RealtimePublisher,
    private readonly notifications?: MessageNotificationPublisher,
    private readonly defer?: (promise: Promise<unknown>) => void
  ) {}

  initialize(): Promise<void> {
    return this.repository.initialize();
  }

  async listChats(actor: MessagingActor) {
    const conversations = await this.repository.listConversationsForUser(actor.userId, 100);
    return Promise.all(conversations.map((conversation) => this.chatSummary(actor.userId, conversation)));
  }

  async openDirectChat(actor: MessagingActor, rawPeerUserId: unknown) {
    const peerUserId = validateUserId(rawPeerUserId);
    if (peerUserId === actor.userId) {
      throw new ApiError(400, "cannot_chat_with_self", "Нельзя создать личный чат с самим собой.");
    }

    const peer = await this.users.findUser(peerUserId);
    if (!peer) notFound("user_not_found", "Пользователь не найден.");

    const conversation = await this.repository.getOrCreateDirectConversation(
      actor.userId,
      peerUserId,
      Date.now()
    );
    return this.chatSummary(actor.userId, conversation, peer);
  }

  async listMessages(actor: MessagingActor, rawConversationId: string) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    return this.repository.listMessages(conversationId, 200, actor.userId);
  }

  async sendMessage(
    actor: MessagingActor,
    rawConversationId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const input = validateMessageInput(body);
    const message: StoredMessage = {
      messageId: crypto.randomUUID(),
      conversationId,
      senderUserId: actor.userId,
      clientMessageId: input.clientMessageId,
      kind: "text",
      text: input.text,
      voice: null,
      createdAt: Date.now(),
      deliveredAt: null
    };
    return this.persistAndPublish(actor, conversation, message);
  }

  async sendVoiceMessage(
    actor: MessagingActor,
    rawConversationId: string,
    prepared: PreparedVoiceMessage
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const message: StoredMessage = {
      messageId: prepared.messageId,
      conversationId,
      senderUserId: actor.userId,
      clientMessageId: prepared.clientMessageId,
      kind: "voice",
      text: "Голосовое сообщение",
      voice: { ...prepared.voice, progress: null },
      createdAt: Date.now(),
      deliveredAt: null
    };
    return this.persistAndPublish(actor, conversation, message);
  }

  async markDelivered(
    actor: MessagingActor,
    rawConversationId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const messageIds = validateDeliveryReceiptInput(body);
    const updates = await this.repository.markMessagesDelivered(
      conversationId,
      actor.userId,
      messageIds,
      Date.now()
    );

    if (updates.length !== messageIds.length) {
      badRequest(
        "invalid_delivery_receipt",
        "Доставку можно подтвердить только для полученных сообщений этого диалога."
      );
    }

    const changedBySender = new Map<string, typeof updates>();
    for (const update of updates) {
      if (!update.changed) continue;
      const list = changedBySender.get(update.message.senderUserId) ?? [];
      list.push(update);
      changedBySender.set(update.message.senderUserId, list);
    }

    for (const [senderUserId, changed] of changedBySender) {
      await this.realtime.publishToUsers([senderUserId], {
        type: "messages.delivered",
        conversationId,
        receipts: changed.map(({ message }) => ({
          messageId: message.messageId,
          clientMessageId: message.clientMessageId,
          deliveredAt: message.deliveredAt
        }))
      });
    }

    return {
      receipts: updates.map(({ message }) => ({
        messageId: message.messageId,
        deliveredAt: message.deliveredAt
      }))
    };
  }

  async cleanupUsers(userIds: string[]): Promise<void> {
    await this.repository.deleteDataForUsers(userIds);
  }

  private async persistAndPublish(
    actor: MessagingActor,
    conversation: DirectConversation,
    message: StoredMessage
  ) {
    const result = await this.repository.insertMessage(message);
    if (result.status === "conflict") {
      conflict(
        "client_message_id_conflict",
        "Этот clientMessageId уже использован для другого сообщения."
      );
    }

    if (result.status === "created") {
      await this.realtime.publishToUsers(participants(conversation), {
        type: "message.created",
        conversationId: conversation.conversationId,
        message: result.message
      });

      if (this.notifications) {
        const recipientUserId = peerUserId(conversation, actor.userId);
        const sender = await this.users.findUser(actor.userId);
        const pushTask = this.notifications.notifyNewMessage({
          recipientUserId,
          senderDisplayName: sender?.displayName ?? "Бульбам",
          conversationId: conversation.conversationId,
          messageId: result.message.messageId,
          text: result.message.text
        }).catch((error) => {
          console.warn("[Push] notification task failed", error);
        });
        if (this.defer) this.defer(pushTask);
        else await pushTask;
      }
    }

    return {
      message: result.message,
      status: "sent" as const,
      duplicate: result.status === "duplicate"
    };
  }

  private async requireConversation(conversationId: string, userId: string): Promise<DirectConversation> {
    const conversation = await this.repository.findConversationForUser(conversationId, userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");
    return conversation;
  }

  private async chatSummary(userId: string, conversation: DirectConversation, knownPeer?: DirectoryUser) {
    const peerUser = peerUserId(conversation, userId);
    const peer = knownPeer ?? await this.users.findUser(peerUser) ?? deletedUser(peerUser);
    const lastMessage = await this.repository.findLatestMessage(conversation.conversationId);
    return {
      conversationId: conversation.conversationId,
      peer,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessage
    };
  }
}

function participants(conversation: DirectConversation): string[] {
  return [conversation.participantAId, conversation.participantBId];
}

function peerUserId(conversation: DirectConversation, userId: string): string {
  return conversation.participantAId === userId
    ? conversation.participantBId
    : conversation.participantAId;
}

function deletedUser(userId: string): DirectoryUser {
  return { userId, username: "deleted", displayName: "Удалённый аккаунт" };
}
