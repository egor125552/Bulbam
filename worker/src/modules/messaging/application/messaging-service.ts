import { ApiError, badRequest, conflict, notFound } from "../../../core/errors";
import type { MessageNotificationPublisher } from "../../notifications/application/push-notification-service";
import type { Conversation, DirectConversation, GroupConversation, MessagingActor, StoredMessage, VoiceAttachment } from "../domain/models";
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
    const conversation=await this.requireConversation(conversationId, actor.userId);
    const messages=await this.repository.listMessages(conversationId, 200, actor.userId);
    if ('title' in conversation) {
      const ownMessages=messages.filter(m=>m.senderUserId===actor.userId);
      const readers=await this.repository.listMessageReaders(conversationId,ownMessages.map(m=>m.messageId));
      const members=await this.repository.listGroupMembers(conversationId);
      for(const message of ownMessages){
        message.readBy=readers.get(message.messageId)??[];
        // Late joiners cannot read earlier messages when history was restricted.
        message.eligibleRecipientCount=members.filter(member=>
          member.userId!==actor.userId && (conversation.historyMode==='all'||member.joinedAt<=message.createdAt)
        ).length;
      }
    }
    return messages;
  }

  async enableDirectProtection(actor:MessagingActor,rawConversationId:string){
    const conversationId=validateConversationId(rawConversationId);
    const conversation=await this.requireConversation(conversationId,actor.userId);
    if('title' in conversation)throw new ApiError(400,'group_encryption_not_supported','Защита групп пока не поддерживается.');
    await this.repository.protectDirectConversation(conversationId);
    await this.realtime.publishToUsers([conversation.participantAId,conversation.participantBId],{
      type:'chat.updated',conversationId
    });
    return {encryptionMode:'protected' as const};
  }

  async sendMessage(
    actor: MessagingActor,
    rawConversationId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateConversationId(rawConversationId);
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const input = validateMessageInput(body);
    if(!('title' in conversation)&&conversation.encryptionMode==='protected' &&
       !/^bmsec1:[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/.test(input.text))
      throw new ApiError(409,'protected_message_required','Защищённый диалог принимает только зашифрованные сообщения.');
    const message: StoredMessage = {
      messageId: crypto.randomUUID(),
      conversationId,
      senderUserId: actor.userId,
      clientMessageId: input.clientMessageId,
      kind: "text",
      text: input.text,
      voice: null,
      createdAt: Date.now(),
      deliveredAt: null,
      readAt: null
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
    const encrypted=prepared.voice.mimeType.startsWith('application/vnd.bulbam.encrypted-voice;v=1;');
    if(!('title' in conversation)&&conversation.encryptionMode==='protected'&&!encrypted)
      throw new ApiError(409,'protected_voice_required','Защищённый диалог принимает только зашифрованные голосовые.');
    const message: StoredMessage = {
      messageId: prepared.messageId,
      conversationId,
      senderUserId: actor.userId,
      clientMessageId: prepared.clientMessageId,
      kind: "voice",
      text: encrypted ? 'bmvoice1' : "Голосовое сообщение",
      voice: { ...prepared.voice, progress: null },
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
        const pushTask=Promise.all(recipients.map(recipientUserId=>this.notifications!.notifyNewMessage({
          recipientUserId,senderDisplayName:sender?.displayName??'Бульбам',
          groupTitle:'title' in conversation?conversation.title:undefined,
          conversationId:conversation.conversationId,messageId:result.message.messageId,text:result.message.text
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

  private async chatSummary(userId: string, conversation: Conversation, knownPeer?: DirectoryUser) {
    if ('title' in conversation) {
      const members=await this.repository.listGroupMembers(conversation.conversationId);
      const list=await this.repository.listMessages(conversation.conversationId,1,userId);
      return {kind:'group',conversationId:conversation.conversationId,title:conversation.title,avatarIcon:conversation.avatarIcon,
        historyMode:conversation.historyMode,ownerUserId:conversation.ownerUserId,
        members:await Promise.all(members.map(async member=>({... (await this.users.findUser(member.userId)??deletedUser(member.userId)),userId:member.userId}))),
        createdAt:conversation.createdAt,lastMessageAt:conversation.lastMessageAt,lastMessage:list.at(-1)??null};
    }
    const peerUser = peerUserId(conversation, userId);
    const peer = knownPeer ?? await this.users.findUser(peerUser) ?? deletedUser(peerUser);
    const lastMessage = await this.repository.findLatestMessage(conversation.conversationId);
    return {
      kind:'direct',
      encryptionMode:conversation.encryptionMode,
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
