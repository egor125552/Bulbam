import { ApiError, badRequest, conflict, notFound } from "../../../core/errors";
import {keyEnvelope,validateDeviceBundle,verifyDeviceBundle,verifyDeviceSignature} from '../domain/device-key-validation';
import {deviceEnvelopeProof,validateEnvelope} from '../domain/device-envelope';
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

  async getFeatures() {
    return {encryption:await this.repository.getFeatureEnabled('encryption')};
  }

  async setFeature(actor:MessagingActor,featureId:string,enabled:unknown){
    if(actor.role!=='owner')
      throw new ApiError(403,'owner_only','Управление функциями доступно только владельцу.');
    if(featureId!=='encryption')
      throw new ApiError(404,'feature_not_found','Функция не найдена.');
    if(typeof enabled!=='boolean')
      badRequest('invalid_feature_setting','Нужно выбрать включено или выключено.');
    await this.repository.setFeatureEnabled(featureId,enabled,actor.userId);
    return {feature:featureId,enabled};
  }

  async changeDirectEncryption(actor:MessagingActor,rawConversationId:string,enabled:unknown){
    if(typeof enabled!=='boolean')
      badRequest('invalid_feature_setting','Нужно выбрать включено или выключено.');
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)
      badRequest('direct_only','Шифрование групп пока не поддерживается.');
    if(!enabled){
      // No push notification. Realtime only synchronizes the two chat views.
      await this.repository.setDirectEncryptionOptOut(conversation.conversationId,true);
    }else{
      if(!await this.repository.getFeatureEnabled('encryption'))
        throw new ApiError(409,'feature_disabled','Защита отключена владельцем Бульбама.');
      if(conversation.protectionOrigin==='manual'){
        // Do not accidentally replace the earlier shared manual AES key.
        await this.repository.reactivateManualEncryption(conversation.conversationId);
      }else{
        // Both endpoints need stable ECDH identities for automatic mode.
        await this.repository.setDirectEncryptionOptOut(conversation.conversationId,false);
        if(!await this.repository.activateAutoProtection(conversation.conversationId)){
          await this.repository.setDirectEncryptionOptOut(conversation.conversationId,true);
          throw new ApiError(409,'keys_not_ready','Ключи собеседников ещё не готовы.');
        }
      }
    }
    await this.realtime.publishToUsers([conversation.participantAId,conversation.participantBId],
      {type:'chat.updated',conversationId:conversation.conversationId});
    return {encryptionMode:enabled?'protected':'plain',autoProtection:enabled && conversation.protectionOrigin!=='manual',encryptionOptOut:!enabled};
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

  async sendE2eeEnvelope(actor:MessagingActor,rawConversationId:string,body:Record<string,unknown>){
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)badRequest('direct_only','Шифрованные конверты пока доступны только для личного чата.');
    if(conversation.encryptionOptOut || !await this.repository.getFeatureEnabled('encryption'))
      throw new ApiError(409,'e2ee_disabled','Защита недоступна для этого чата.');
    const envelope=validateEnvelope(body);
    const receiverId=conversation.participantAId===actor.userId?
      conversation.participantBId:conversation.participantAId;
    // Own devices are also legitimate recipients of an encrypted sync copy.
    if(envelope.recipientUserId!==receiverId && envelope.recipientUserId!==actor.userId)
      throw new ApiError(403,'recipient_not_member','Получатель не участвует в переписке.');
    const senders=await this.repository.listDevices(actor.userId,false);
    const sender=senders.find(x=>x.deviceId===envelope.senderDeviceId);
    const targets=await this.repository.listDevices(envelope.recipientUserId,false);
    const target=targets.find(x=>x.deviceId===envelope.recipientDeviceId);
    if(!sender || !target)
      throw new ApiError(409,'e2ee_device_untrusted','Устройство не зарегистрировано как доверенное.');
    const context=deviceEnvelopeProof(conversation.conversationId,actor.userId,envelope);
    if(!await verifyDeviceSignature(sender.identitySigning,context,envelope.signature))
      badRequest('invalid_envelope_signature','Подпись зашифрованного сообщения неверна.');
    let stored;
    try{stored=await this.repository.insertDeviceEnvelope(conversation.conversationId,actor.userId,envelope,sender.identitySigning);}
    catch(error){
      if(error instanceof Error&&error.message==='ENVELOPE_IDEMPOTENCY_CONFLICT')
        throw new ApiError(409,'e2ee_message_conflict','Повторная отправка содержит другой шифротекст.');
      throw error;
    }
    if(stored.created){
      const task=this.realtime.publishToUsers([envelope.recipientUserId],{
        type:'e2ee.envelope.created',conversationId:conversation.conversationId,
        clientMessageId:envelope.clientMessageId,recipientDeviceId:envelope.recipientDeviceId
      }).catch(error=>console.warn('[E2EE] realtime dispatch failed',error));
      if(this.defer)this.defer(task);else await task;
      if(this.notifications && envelope.recipientUserId!==actor.userId){
        const sender=await this.users.findUser(actor.userId);
        const push=this.notifications.notifyNewMessage({
          recipientUserId:envelope.recipientUserId,
          senderDisplayName:sender?.displayName??'Бульбам',
          conversationId:conversation.conversationId,messageId:stored.envelope.envelopeId,
          text:'Новое сообщение'
        }).catch(error=>console.warn('[E2EE] push dispatch failed',error));
        if(this.defer)this.defer(push);else await push;
      }
    }
    return {envelope:stored.envelope};
  }

  async fetchE2eeEnvelopes(actor:MessagingActor,rawConversationId:string,deviceId:string){
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)badRequest('direct_only','Шифрованные конверты пока доступны только для личного чата.');
    const devices=await this.repository.listDevices(actor.userId,false);
    if(!devices.some(x=>x.deviceId===deviceId))
      throw new ApiError(403,'device_untrusted','Нельзя получить сообщения на недоверенное устройство.');
    return {envelopes:await this.repository.listDeviceEnvelopes(conversation.conversationId,actor.userId,deviceId)};
  }

  async ackE2eeEnvelope(actor:MessagingActor,rawConversationId:string,rawEnvelopeId:string,deviceId:string,signature:string){
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)badRequest('direct_only','Шифрованные конверты пока доступны только для личного чата.');
    if(!/^[0-9a-f-]{36}$/i.test(rawEnvelopeId))badRequest('invalid_envelope','Неверный идентификатор конверта.');
    const devices=await this.repository.listDevices(actor.userId,false);
    const own=devices.find(x=>x.deviceId===deviceId);
    if(!own)throw new ApiError(403,'device_untrusted','Недоверенное устройство.');
    if(!/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      !await verifyDeviceSignature(own.identitySigning,
        JSON.stringify(['bulbam/e2ee-envelope-ack/v2',conversation.conversationId,actor.userId,deviceId,rawEnvelopeId]),signature))
      badRequest('invalid_envelope_ack','Подтверждение доставки должно быть подписано устройством.');
    const acknowledged=await this.repository.acknowledgeDeviceEnvelope(rawEnvelopeId,
      conversation.conversationId,actor.userId,deviceId);
    if(!acknowledged)throw new ApiError(404,'envelope_not_found','Конверт уже прочитан или недоступен.');
    return {acknowledged:true};
  }

  async registerE2eeDevice(actor:MessagingActor,raw:Record<string,unknown>){
    const bundle=validateDeviceBundle(raw);
    if(!await verifyDeviceBundle(actor.userId,bundle))
      badRequest('invalid_device_proof','Подпись нового устройства не прошла проверку.');
    const result=await this.repository.registerDevice(actor.userId,bundle);
    if(!result)
      throw new ApiError(409,'device_identity_conflict','Этот идентификатор уже используется другим или отозванным устройством.');
    return {device:result};
  }

  async listOwnE2eeDevices(actor:MessagingActor){
    return {devices:await this.repository.listDevices(actor.userId,true)};
  }

  async listE2eePeerDevices(actor:MessagingActor,rawConversationId:string){
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)badRequest('direct_only','Ключи устройств доступны только для личной переписки.');
    const users=[conversation.participantAId,conversation.participantBId];
    const bundles=await Promise.all(users.map(async userId=>({
      userId,devices:await this.repository.listDevices(userId,false)
    })));
    return {users:bundles};
  }

  async approveE2eeDevice(actor:MessagingActor,raw:Record<string,unknown>){
    const approverDeviceId=raw.approverDeviceId;
    const newDeviceId=raw.newDeviceId;
    const signature=raw.signature;
    if(typeof approverDeviceId!=='string'||typeof newDeviceId!=='string'||
      typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))
      badRequest('invalid_device_approval','Недопустимое подтверждение устройства.');
    const devices=await this.repository.listDevices(actor.userId,true);
    const approver=devices.find(device=>device.deviceId===approverDeviceId && device.trust==='active');
    const pending=devices.find(device=>device.deviceId===newDeviceId && device.trust==='pending');
    if(!approver || !pending || approver.deviceId===pending.deviceId)
      throw new ApiError(409,'approval_not_allowed','Нужно подтверждение с уже доверенного устройства.');
    const valid=await verifyDeviceSignature(approver.identitySigning,
      keyEnvelope('approval',actor.userId,pending.deviceId,pending,approver.deviceId),signature);
    if(!valid)badRequest('invalid_device_approval','Подпись подтверждения недействительна.');
    if(!await this.repository.approveDevice(actor.userId,pending.deviceId))
      throw new ApiError(409,'approval_conflict','Устройство уже изменило состояние.');
    return {approvedDeviceId:pending.deviceId};
  }

  async revokeE2eeDevice(actor:MessagingActor,raw:Record<string,unknown>){
    // An ordinary logged-in session is not sufficient to revoke trusted keys.
    // The revocation must be signed by another already trusted device.
    const approvingId=raw.approverDeviceId;
    const targetId=raw.deviceId;
    const signature=raw.signature;
    if(typeof approvingId!=='string'||typeof targetId!=='string'||
      typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))
      badRequest('invalid_device_revoke','Неверная подпись отзыва устройства.');
    const devices=await this.repository.listDevices(actor.userId,true);
    const approver=devices.find(device=>device.deviceId===approvingId&&device.trust==='active');
    const target=devices.find(device=>device.deviceId===targetId&&device.trust==='active');
    if(!approver||!target||approver.deviceId===target.deviceId)
      throw new ApiError(409,'revoke_not_allowed','Для отзыва требуется другое доверенное устройство.');
    const payload=JSON.stringify(['bulbam/device-revoke/v1',actor.userId,approver.deviceId,target.deviceId]);
    if(!await verifyDeviceSignature(approver.identitySigning,payload,signature))
      badRequest('invalid_device_revoke','Неверная подпись отзыва устройства.');
    if(!await this.repository.revokeDevice(actor.userId,target.deviceId))
      throw new ApiError(409,'revoke_conflict','Устройство уже изменило состояние.');
    return {revokedDeviceId:target.deviceId};
  }

  async registerAutoIdentity(actor:MessagingActor,raw:Record<string,unknown>){
    const key=raw.publicKey;
    if(!key||typeof key!=='object'||Array.isArray(key))badRequest('invalid_public_key','Неверный открытый ключ устройства.');
    const fields=key as Record<string,unknown>;
    const canonical=JSON.stringify({kty:fields.kty,crv:fields.crv,x:fields.x,y:fields.y});
    if(fields.kty!=='EC'||fields.crv!=='P-256'||
      typeof fields.x!=='string'||typeof fields.y!=='string'||
      !/^[A-Za-z0-9_-]{43}$/.test(fields.x)||!/^[A-Za-z0-9_-]{43}$/.test(fields.y))
      badRequest('invalid_public_key','Нужен открытый ECDH P-256 ключ.');
    const previouslyRegistered=(await this.repository.identityKeys([actor.userId])).has(actor.userId);
    // Never permanently pin an invalid EC point. Web Crypto validates the curve.
    try{await crypto.subtle.importKey('jwk',JSON.parse(canonical),{name:'ECDH',namedCurve:'P-256'},false,[]);}
    catch{badRequest('invalid_public_key','Открытый ключ не принадлежит кривой P-256.');}
    if(!await this.repository.registerIdentityKey(actor.userId,canonical))
      throw new ApiError(409,'identity_key_conflict','У аккаунта уже есть другой ключ устройства. Не заменяем секрет незаметно.');
    if(!previouslyRegistered){
      const existing=await this.repository.listConversationsForUser(actor.userId,100);
      await Promise.all(existing.map(chat=>this.realtime.publishToUsers(
        [chat.participantAId===actor.userId?chat.participantBId:chat.participantAId],
        {type:'chat.updated',conversationId:chat.conversationId}
      )));
    }
    return {registered:true};
  }

  async autoIdentityKeys(actor:MessagingActor,rawConversationId:string){
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)badRequest('auto_keys_direct_only','Автоматический обмен доступен только личным чатам.');
    const keys=await this.repository.identityKeys([conversation.participantAId,conversation.participantBId]);
    return {autoProtection:conversation.autoProtection,keys:Object.fromEntries([...keys].map(([id,jwk])=>[id,JSON.parse(jwk)]))};
  }

  async activateAutoProtection(actor:MessagingActor,rawConversationId:string){
    if(!await this.repository.getFeatureEnabled('encryption'))
      throw new ApiError(409,'feature_disabled','Защита отключена владельцем Бульбама.');
    const conversation=await this.requireConversation(validateConversationId(rawConversationId),actor.userId);
    if('title' in conversation)badRequest('auto_keys_direct_only','Автоматический обмен доступен только личным чатам.');
    if(conversation.encryptionOptOut)
      throw new ApiError(409,'chat_protection_disabled','Защита выключена в этом чате.');
    if(conversation.encryptionMode==='protected'&&!conversation.autoProtection)
      throw new ApiError(409,'legacy_manual_protection','В этом чате уже включён ручной ключ. Автоматическая смена нарушила бы историю.');
    const enabled=await this.repository.activateAutoProtection(conversation.conversationId);
    if(!enabled)throw new ApiError(409,'auto_keys_not_ready','Для автоматической защиты оба собеседника должны зарегистрировать свои ключи.');
    await this.realtime.publishToUsers([conversation.participantAId,conversation.participantBId],{
      type:'chat.updated',conversationId:conversation.conversationId
    });
    return {encryptionMode:'protected' as const,autoProtection:true};
  }

  async enableDirectProtection(actor:MessagingActor,rawConversationId:string){
    if(!await this.repository.getFeatureEnabled('encryption'))
      throw new ApiError(409,'feature_disabled','Защита отключена владельцем Бульбама.');
    const conversationId=validateConversationId(rawConversationId);
    const conversation=await this.requireConversation(conversationId,actor.userId);
    if('title' in conversation)throw new ApiError(400,'group_encryption_not_supported','Защита групп пока не поддерживается.');
    if(conversation.encryptionOptOut)
      throw new ApiError(409,'chat_protection_disabled','Защита выключена в этом чате.');
    if(conversation.autoProtection)
      throw new ApiError(409,'already_auto_protected','Этот чат уже защищён автоматическим обменом.');
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
      autoProtection:conversation.autoProtection,
      encryptionOptOut:conversation.encryptionOptOut,
      protectionOrigin:conversation.protectionOrigin,
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
