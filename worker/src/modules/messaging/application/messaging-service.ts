import { ApiError, badRequest, conflict, notFound } from "../../../core/errors";
import type { MessageNotificationPublisher } from "../../notifications/application/push-notification-service";
import type {
  Conversation,
  DirectConversation,
  FileAttachment,
  GroupConversation,
  MessageReplyPreview,
  MessagingActor,
  StoredMessage,
  VoiceAttachment
} from "../domain/models";
import {
  validateConversationId,
  validateDeleteScope,
  validateDeliveryReceiptInput,
  validateForwardInput,
  validateMessageId,
  validateMessageInput,
  validateReactionEmoji,
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

export interface PreparedFileMessage {
  messageId: string;
  clientMessageId: string;
  text: string;
  file: FileAttachment;
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
    const conversations = await this.repository.listAllConversationsForUser(actor.userId, 100);
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

  async createGroup(actor:MessagingActor, body:Record<string,unknown>) {
    const title=validateGroupTitle(body.title);
    const avatarIcon=validateGroupIcon(body.avatarIcon);
    const userIds=validateGroupUsers(body.userIds,actor.userId);
    const historyMode=validateHistoryMode(body.historyMode);
    for(const userId of userIds) if(!await this.users.findUser(userId)) notFound('user_not_found','Один из пользователей не найден.');
    const group=await this.repository.createGroup(title,avatarIcon,actor.userId,userIds,historyMode,Date.now());
    const summary=await this.chatSummary(actor.userId,group);
    await this.realtime.publishToUsers(userIds,{type:'chat.created',conversationId:group.conversationId});
    return summary;
  }

  async groupMembers(actor:MessagingActor,rawConversationId:string) {
    const group=await this.requireGroup(rawConversationId,actor.userId);
    const members=await this.repository.listGroupMembers(group.conversationId);
    return {group, members:await Promise.all(members.map(async member=>({
      ...member,user:await this.users.findUser(member.userId)??deletedUser(member.userId)
    })))};
  }

  async addGroupMembers(actor:MessagingActor,rawConversationId:string,body:Record<string,unknown>) {
    const group=await this.requireGroup(rawConversationId,actor.userId);
    if(group.ownerUserId!==actor.userId)throw new ApiError(403,'group_owner_only','Добавлять участников может только создатель группы.');
    const ids=validateGroupUsers(body.userIds,actor.userId);
    const existing=new Set((await this.repository.listGroupMembers(group.conversationId)).map(x=>x.userId));
    if(ids.length+existing.size>100)badRequest('group_too_large','В группе может быть не больше 100 участников.');
    for(const id of ids)if(!await this.users.findUser(id))notFound('user_not_found','Пользователь не найден.');
    const fresh=ids.filter(id=>!existing.has(id));
    await this.repository.addGroupMembers(group.conversationId,fresh,Date.now());
    if(fresh.length)await this.realtime.publishToUsers(fresh,{type:'chat.created',conversationId:group.conversationId});
    await this.realtime.publishToUsers(await this.repository.listConversationRecipients(group),{type:'chat.updated',conversationId:group.conversationId});
    return this.groupMembers(actor,group.conversationId);
  }

  async removeGroupMember(actor:MessagingActor,rawConversationId:string,rawUserId:string) {
    const group=await this.requireGroup(rawConversationId,actor.userId);
    const userId=validateUserId(rawUserId);
    if(userId===group.ownerUserId)throw new ApiError(400,'group_owner_cannot_leave','Создатель пока не может выйти из своей группы.');
    if(userId!==actor.userId&&actor.userId!==group.ownerUserId)
      throw new ApiError(403,'group_owner_only','Исключать других участников может только создатель группы.');
    const memberIds=(await this.repository.listGroupMembers(group.conversationId)).map(m=>m.userId);
    if(!memberIds.includes(userId))notFound('group_member_not_found','Этот человек не участвует в группе.');
    await this.repository.removeGroupMember(group.conversationId,userId);
    await this.realtime.publishToUsers([userId],{type:'chat.removed',conversationId:group.conversationId});
    await this.realtime.publishToUsers(memberIds.filter(id=>id!==userId),{type:'chat.updated',conversationId:group.conversationId});
    return {removedUserId:userId};
  }

  private async requireGroup(rawConversationId:string,userId:string):Promise<GroupConversation> {
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),userId);
    if(!('title' in conversation))notFound('group_not_found','Группа не найдена.');
    return conversation as GroupConversation;
  }

  async listMessages(actor: MessagingActor, rawConversationId: string) {
    const conversationId = validateConversationId(rawConversationId);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const messages = await this.repository.listMessages(conversationId, 200, actor.userId);
    if ("title" in conversation) {
      const ownMessages = messages.filter((m) => m.senderUserId === actor.userId);
      const readers = await this.repository.listMessageReaders(conversationId, ownMessages.map((m) => m.messageId));
      const members = await this.repository.listGroupMembers(conversationId);
      for (const message of ownMessages) {
        message.readBy = readers.get(message.messageId) ?? [];
        // Late joiners cannot read earlier messages when history was restricted.
        message.eligibleRecipientCount = members.filter((member) =>
          member.userId !== actor.userId && (conversation.historyMode === "all" || member.joinedAt <= message.createdAt)
        ).length;
      }
    }
    await this.enrichMessages(conversationId, messages, actor.userId);
    return messages;
  }

  async sendMessage(
    actor: MessagingActor,
    rawConversationId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const input = validateMessageInput(body);
    let replyTo: MessageReplyPreview | null = null;
    if (input.replyToMessageId) {
      const target = await this.repository.findMessageForUser(conversationId, input.replyToMessageId, actor.userId);
      if (!target) {
        notFound("reply_target_not_found", "Сообщение для ответа не найдено в этом чате.");
      }
      replyTo = await this.buildReplyPreview(target);
    }
    const message: StoredMessage = {
      messageId: crypto.randomUUID(),
      conversationId,
      senderUserId: actor.userId,
      clientMessageId: input.clientMessageId,
      kind: "text",
      text: input.text,
      voice: null,
      replyToMessageId: input.replyToMessageId,
      replyTo,
      forwardedFrom: null,
      reactions: [],
      isFavorite: false,
      createdAt: Date.now(),
      deliveredAt: null,
      readAt: null
    };
    return this.persistAndPublish(actor, conversation, message);
  }

  async forwardMessage(
    actor: MessagingActor,
    rawTargetConversationId: string,
    body: Record<string, unknown>
  ) {
    const targetConversationId = validateConversationId(rawTargetConversationId);
    const targetConversation = await this.requireConversation(targetConversationId, actor.userId);
    const input = validateForwardInput(body);
    await this.requireConversation(input.sourceConversationId, actor.userId);
    const source = await this.repository.findMessageForUser(
      input.sourceConversationId,
      input.sourceMessageId,
      actor.userId
    );
    if (!source) {
      notFound("message_not_found", "Сообщение для пересылки не найдено.");
    }

    const fromUserId = source.forwardedFrom?.fromUserId || source.senderUserId;
    const fromDisplayName = source.forwardedFrom?.fromDisplayName ||
      (await this.users.findUser(source.senderUserId))?.displayName ||
      "Удалённый аккаунт";

    const forwardedText = formatForwardedMessageText(source);
    const message: StoredMessage = {
      messageId: crypto.randomUUID(),
      conversationId: targetConversationId,
      senderUserId: actor.userId,
      clientMessageId: input.clientMessageId,
      kind: "text",
      text: forwardedText,
      voice: null,
      file: null,
      replyToMessageId: null,
      replyTo: null,
      forwardedFrom: { fromUserId, fromDisplayName },
      reactions: [],
      isFavorite: false,
      createdAt: Date.now(),
      deliveredAt: null,
      readAt: null
    };
    return this.persistAndPublish(actor, targetConversation, message);
  }

  async deleteMessage(
    actor: MessagingActor,
    rawConversationId: string,
    rawMessageId: string,
    rawScope: unknown
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateMessageId(rawMessageId);
    const scope = validateDeleteScope(rawScope);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const message = await this.repository.findMessageForUser(conversationId, messageId, actor.userId);
    if (!message) notFound("message_not_found", "Сообщение не найдено.");

    if (scope === "me") {
      await this.repository.hideMessageForUser(conversationId, messageId, actor.userId, Date.now());
      await this.realtime.publishToUsers([actor.userId], {
        type: "message.deleted",
        conversationId,
        messageId,
        scope: "me"
      });
      return { deletedMessageId: messageId, scope: "me" as const };
    }

    const canDeleteForEveryone =
      message.senderUserId === actor.userId ||
      ("title" in conversation && conversation.ownerUserId === actor.userId);
    if (!canDeleteForEveryone) {
      throw new ApiError(403, "delete_forbidden", "Удалить чужое сообщение у всех нельзя.");
    }

    await this.repository.deleteMessageForEveryone(conversationId, messageId);
    const recipients = await this.repository.listConversationRecipients(conversation);
    await this.realtime.publishToUsers(recipients, {
      type: "message.deleted",
      conversationId,
      messageId,
      scope: "everyone"
    });
    return { deletedMessageId: messageId, scope: "everyone" as const };
  }

  async toggleReaction(
    actor: MessagingActor,
    rawConversationId: string,
    rawMessageId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateMessageId(rawMessageId);
    const emoji = validateReactionEmoji(body.emoji);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const message = await this.repository.findMessageForUser(conversationId, messageId, actor.userId);
    if (!message) notFound("message_not_found", "Сообщение не найдено.");

    const result = await this.repository.toggleReaction(messageId, actor.userId, emoji, Date.now());
    const recipients = await this.repository.listConversationRecipients(conversation);
    await this.realtime.publishToUsers(recipients, {
      type: "message.reactions.updated",
      conversationId,
      messageId,
      reactions: result.reactions.map(({ emoji: itemEmoji, count, userIds }) => ({
        emoji: itemEmoji,
        count,
        userIds
      }))
    });
    return { messageId, emoji, added: result.added, reactions: result.reactions };
  }

  async addFavorite(actor: MessagingActor, rawConversationId: string, rawMessageId: string) {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateMessageId(rawMessageId);
    await this.requireConversation(conversationId, actor.userId);
    const message = await this.repository.findMessageForUser(conversationId, messageId, actor.userId);
    if (!message) notFound("message_not_found", "Сообщение не найдено.");

    await this.repository.addFavorite(actor.userId, conversationId, messageId, Date.now());
    await this.realtime.publishToUsers([actor.userId], {
      type: "favorites.updated",
      conversationId,
      messageId,
      isFavorite: true
    });
    return { messageId, isFavorite: true };
  }

  async removeFavorite(actor: MessagingActor, rawConversationId: string, rawMessageId: string) {
    const conversationId = validateConversationId(rawConversationId);
    const messageId = validateMessageId(rawMessageId);
    await this.requireConversation(conversationId, actor.userId);
    await this.repository.removeFavorite(actor.userId, messageId);
    await this.realtime.publishToUsers([actor.userId], {
      type: "favorites.updated",
      conversationId,
      messageId,
      isFavorite: false
    });
    return { messageId, isFavorite: false };
  }

  async listFavorites(actor: MessagingActor) {
    const entries = await this.repository.listFavorites(actor.userId, 200);
    const conversationCache = new Map<string, Conversation | null>();
    const userCache = new Map<string, DirectoryUser>();
    const resolveUser = async (userId: string): Promise<DirectoryUser> => {
      const cached = userCache.get(userId);
      if (cached) return cached;
      const found = (await this.users.findUser(userId)) ?? deletedUser(userId);
      userCache.set(userId, found);
      return found;
    };

    const items = [];
    for (const entry of entries) {
      let conversation = conversationCache.get(entry.conversationId);
      if (conversation === undefined) {
        conversation = await this.repository.findAnyConversationForUser(entry.conversationId, actor.userId);
        conversationCache.set(entry.conversationId, conversation);
      }
      if (!conversation) continue;
      const sender = await resolveUser(entry.message.senderUserId);
      let chatTitle = "Чат";
      let chatKind: "direct" | "group" = "direct";
      if ("title" in conversation) {
        chatKind = "group";
        chatTitle = conversation.title;
      } else {
        const peer = await resolveUser(peerUserId(conversation, actor.userId));
        chatTitle = peer.displayName;
      }
      items.push({
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        savedAt: entry.savedAt,
        chatKind,
        chatTitle,
        senderUserId: sender.userId,
        senderDisplayName: sender.displayName,
        senderUsername: sender.username,
        kind: entry.message.kind,
        text: entry.message.text,
        fileName: entry.message.file?.fileName ?? null,
        voiceDurationMs: entry.message.voice?.durationMs ?? null,
        createdAt: entry.message.createdAt
      });
    }
    return items;
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
      file: null,
      createdAt: Date.now(),
      deliveredAt: null,
      readAt: null
    };
    return this.persistAndPublish(actor, conversation, message);
  }

  async sendFileMessage(
    actor: MessagingActor,
    rawConversationId: string,
    prepared: PreparedFileMessage
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const message: StoredMessage = {
      messageId: prepared.messageId,
      conversationId,
      senderUserId: actor.userId,
      clientMessageId: prepared.clientMessageId,
      kind: "file",
      text: prepared.text,
      voice: null,
      file: prepared.file,
      createdAt: Date.now(),
      deliveredAt: null,
      readAt: null
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

  async markRead(
    actor: MessagingActor,
    rawConversationId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    await this.requireConversation(conversationId, actor.userId);
    const messageIds = validateDeliveryReceiptInput(body);
    const updates = await this.repository.markMessagesRead(
      conversationId, actor.userId, messageIds, Date.now()
    );

    if (updates.length !== messageIds.length) {
      badRequest("invalid_read_receipt", "Прочтение можно подтвердить только для полученных сообщений этого диалога.");
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
        type: "messages.read",
        conversationId,
        receipts: changed.map(({ message }) => ({
          messageId: message.messageId,
          clientMessageId: message.clientMessageId,
          deliveredAt: message.deliveredAt,
          readAt: message.readAt
        }))
      });
    }
    return {
      receipts: updates.map(({ message }) => ({
        messageId: message.messageId,
        deliveredAt: message.deliveredAt,
        readAt: message.readAt
      }))
    };
  }

  async cleanupUsers(userIds: string[]): Promise<void> {
    await this.repository.deleteDataForUsers(userIds);
  }

  async purgeDeletedUserAccount(input: {
    targetUserId: string;
    targetDisplayName: string;
    targetUsername: string;
    ownerUserId: string;
  }): Promise<{ removedDirectChats: number; updatedGroups: number }> {
    const now = Date.now();
    const groupNoticeBody = `Участник ${input.targetDisplayName} (@${input.targetUsername}) исключён: аккаунт удалён владельцем.`;
    const result = await this.repository.purgeDeletedUserData({
      targetUserId: input.targetUserId,
      groupNoticeSenderFallbackUserId: input.ownerUserId,
      groupNoticeBody,
      now
    });

    const notifications: Promise<unknown>[] = [];
    for (const direct of result.removedDirectConversations) {
      if (direct.peerUserId && direct.peerUserId !== input.targetUserId) {
        notifications.push(
          this.realtime.publishToUsers([direct.peerUserId], {
            type: "chat.removed",
            conversationId: direct.conversationId
          })
        );
      }
    }
    for (const group of result.updatedGroups) {
      if (group.noticeMessage) {
        notifications.push(
          this.realtime.publishToUsers(group.remainingMemberIds, {
            type: "message.created",
            conversationId: group.conversationId,
            message: group.noticeMessage
          })
        );
      }
      notifications.push(
        this.realtime.publishToUsers(group.remainingMemberIds, {
          type: "chat.updated",
          conversationId: group.conversationId
        })
      );
    }

    const notifyAll = Promise.all(notifications).catch((error) =>
      console.warn("[MessagingService] purge notifications failed", error)
    );
    if (this.defer) this.defer(notifyAll);
    else await notifyAll;

    return {
      removedDirectChats: result.removedDirectConversations.length,
      updatedGroups: result.updatedGroups.length
    };
  }

  private async persistAndPublish(
    actor: MessagingActor,
    conversation: Conversation,
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
      const allRecipients=await this.repository.listConversationRecipients(conversation);
      const visibleRecipients='title' in conversation&&conversation.historyMode==='since_join'
        ? new Set((await this.repository.listGroupMembers(conversation.conversationId))
            .filter(member=>member.joinedAt<=result.message.createdAt)
            .map(member=>member.userId))
        : new Set(allRecipients);
      const messageRecipients=allRecipients.filter(id=>visibleRecipients.has(id));
      await this.realtime.publishToUsers(messageRecipients, {
        type: "message.created",
        conversationId: conversation.conversationId,
        message: result.message
      });

      if (this.notifications) {
        const recipients=messageRecipients.filter(id=>id!==actor.userId);
        const sender=await this.users.findUser(actor.userId);
        const notificationText = messageNotificationText(result.message);
        const pushTask=Promise.all(recipients.map(recipientUserId=>this.notifications!.notifyNewMessage({
          recipientUserId,senderDisplayName:sender?.displayName??'Бульбам',
          groupTitle:'title' in conversation?conversation.title:undefined,
          conversationId:conversation.conversationId,messageId:result.message.messageId,text:notificationText
        }))).catch(error=>console.warn('[Push] notification task failed',error));
        if(this.defer)this.defer(pushTask);
        else await pushTask;
      }
    }

    return {
      message: result.message,
      status: "sent" as const,
      duplicate: result.status === "duplicate"
    };
  }

  private async requireConversation(conversationId: string, userId: string): Promise<Conversation> {
    const conversation = await this.repository.findAnyConversationForUser(conversationId, userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");
    return conversation;
  }

  private async enrichMessages(
    conversationId: string,
    messages: StoredMessage[],
    viewerUserId: string
  ): Promise<void> {
    if (!messages.length) return;
    const messageIds = messages.map((message) => message.messageId);
    const replyIds = messages
      .map((message) => message.replyToMessageId)
      .filter((id): id is string => Boolean(id));

    const [reactionsMap, favoriteIds, replyTargets] = await Promise.all([
      this.repository.listReactionsForMessages(messageIds, viewerUserId),
      this.repository.listFavoriteIds(viewerUserId, messageIds),
      replyIds.length
        ? this.repository.listMessagesByIds(conversationId, replyIds, viewerUserId)
        : Promise.resolve(new Map<string, StoredMessage>())
    ]);

    const userCache = new Map<string, DirectoryUser>();
    const resolveName = async (userId: string) => {
      const cached = userCache.get(userId);
      if (cached) return cached.displayName;
      const found = (await this.users.findUser(userId)) ?? deletedUser(userId);
      userCache.set(userId, found);
      return found.displayName;
    };

    for (const message of messages) {
      message.reactions = reactionsMap.get(message.messageId) ?? [];
      message.isFavorite = favoriteIds.has(message.messageId);
      if (message.replyToMessageId) {
        const target = replyTargets.get(message.replyToMessageId);
        if (target) {
          message.replyTo = {
            messageId: target.messageId,
            senderUserId: target.senderUserId,
            senderDisplayName: await resolveName(target.senderUserId),
            kind: target.kind,
            text: replyPreviewText(target),
            deleted: false
          };
        } else {
          message.replyTo = {
            messageId: message.replyToMessageId,
            senderUserId: "",
            senderDisplayName: "",
            kind: "text",
            text: "Сообщение удалено",
            deleted: true
          };
        }
      }
    }
  }

  private async buildReplyPreview(target: StoredMessage): Promise<MessageReplyPreview> {
    const sender = (await this.users.findUser(target.senderUserId)) ?? deletedUser(target.senderUserId);
    return {
      messageId: target.messageId,
      senderUserId: target.senderUserId,
      senderDisplayName: sender.displayName,
      kind: target.kind,
      text: replyPreviewText(target),
      deleted: false
    };
  }

  private async chatSummary(userId: string, conversation: Conversation, knownPeer?: DirectoryUser) {
    if ("title" in conversation) {
      const members = await this.repository.listGroupMembers(conversation.conversationId);
      const list = await this.repository.listMessages(conversation.conversationId, 1, userId);
      return {
        kind: "group",
        conversationId: conversation.conversationId,
        title: conversation.title,
        avatarIcon: conversation.avatarIcon,
        historyMode: conversation.historyMode,
        ownerUserId: conversation.ownerUserId,
        members: await Promise.all(members.map(async (member) => ({
          ...(await this.users.findUser(member.userId) ?? deletedUser(member.userId)),
          userId: member.userId
        }))),
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastMessageAt,
        lastMessage: list.at(-1) ?? null
      };
    }
    const peerUser = peerUserId(conversation, userId);
    const peer = knownPeer ?? await this.users.findUser(peerUser) ?? deletedUser(peerUser);
    const lastMessage = await this.repository.findLatestMessage(conversation.conversationId, userId);
    return {
      kind: "direct",
      conversationId: conversation.conversationId,
      peer,
      createdAt: conversation.createdAt,
      lastMessageAt: lastMessage?.createdAt ?? conversation.lastMessageAt,
      lastMessage
    };
  }
}

function replyPreviewText(message: StoredMessage): string {
  if (message.kind === "voice") return "Голосовое сообщение";
  if (message.kind === "file" && message.file) {
    return messageNotificationText(message).slice(0, 140);
  }
  const compact = message.text.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}…` : compact;
}

function formatForwardedMessageText(message: StoredMessage): string {
  if (message.kind === "voice") {
    const seconds = Math.max(1, Math.round((message.voice?.durationMs ?? 0) / 1000));
    const mins = Math.floor(seconds / 60);
    const secs = String(seconds % 60).padStart(2, "0");
    return `Голосовое сообщение (${mins}:${secs})`;
  }
  if (message.kind === "file" && message.file) {
    return messageNotificationText(message);
  }
  return message.text;
}

function messageNotificationText(message: StoredMessage): string {
  if (message.kind === "file" && message.file) {
    const label =
      message.file.mediaKind === "image"
        ? "Фото"
        : message.file.mediaKind === "video"
          ? "Видео"
          : message.file.mediaKind === "audio"
            ? "Аудио"
            : "Файл";
    const base = `${label}: ${message.file.fileName}`;
    const caption = message.text.replace(/\s+/g, " ").trim();
    return caption ? `${base} — ${caption}` : base;
  }
  return message.text;
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

function validateGroupTitle(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.trim().length>80)
    badRequest('invalid_group_title','Название группы должно содержать от 1 до 80 символов.');
  return value.trim();
}
function validateGroupUsers(value:unknown,self:string):string[] {
  if(!Array.isArray(value)||!value.length||value.length>99)
    badRequest('invalid_group_members','Выберите от 1 до 99 участников.');
  const ids=[...new Set(value.map(validateUserId))];
  if(ids.includes(self))badRequest('invalid_group_members','Создатель уже входит в группу.');
  return ids;
}
function validateHistoryMode(value:unknown):'all'|'since_join' {
  if(value!=='all'&&value!=='since_join')badRequest('invalid_group_history','Выберите, доступна ли старшая история новым участникам.');
  return value;
}

function validateGroupIcon(value:unknown):string {
  if(value===undefined)return '👥';
  if(typeof value!=='string'||!['👥','🏠','⭐','🌿','💬'].includes(value))
    badRequest('invalid_group_icon','Выберите готовый значок группы.');
  return value;
}
