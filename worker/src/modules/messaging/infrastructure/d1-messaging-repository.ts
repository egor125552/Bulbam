import type { D1Database } from "../../../platform/cloudflare";
import type {DevicePublicKey,DeviceBundle,RegisteredDevice} from '../domain/device-key-validation';
import type {SealedDeviceEnvelope,StoredDeviceEnvelope} from '../domain/device-envelope';
import type {
  DeliveryReceiptUpdate,
  DirectConversation,
  Conversation,
  GroupConversation,
  GroupMember,
  StoredMessage,
  VoiceListenUpdate
} from "../domain/models";
import type { InsertMessageResult, MessagingRepository } from "../ports/messaging-repository";
import { ensureMessagingSchema } from "./schema";

type Row = Record<string, unknown>;

const MESSAGE_COLUMNS = `
  m.message_id,
  m.conversation_id,
  m.sender_user_id,
  m.client_message_id,
  m.message_type,
  m.body,
  m.created_at,
  (
    SELECT r.delivered_at
    FROM message_receipts r
    WHERE r.message_id = m.message_id
    ORDER BY r.delivered_at DESC
    LIMIT 1
  ) AS delivered_at,
  (
    SELECT r.read_at
    FROM message_receipts r
    WHERE r.message_id = m.message_id
    ORDER BY r.read_at DESC
    LIMIT 1
  ) AS read_at,
  v.object_key,
  v.duration_ms,
  v.mime_type,
  v.bitrate_bps,
  v.size_bytes,
  vl.listener_user_id,
  vl.listened_ms,
  vl.resume_ms,
  vl.heard_ranges,
  vl.completed_at,
  vl.updated_at AS voice_updated_at,
  COALESCE(vps.share_progress, 1) AS share_progress
`;

const MESSAGE_JOINS = `
  LEFT JOIN voice_message_attachments v ON v.message_id = m.message_id
  LEFT JOIN voice_listen_receipts vl ON vl.message_id = m.message_id AND (
    vl.listener_user_id = ? OR (m.sender_user_id = ? AND EXISTS (
      SELECT 1 FROM conversations direct_chat WHERE direct_chat.conversation_id=m.conversation_id AND direct_chat.kind='direct'
    ))
  )
  LEFT JOIN voice_privacy_settings vps ON vps.user_id = vl.listener_user_id
`;

export class D1MessagingRepository implements MessagingRepository {
  constructor(private readonly db: D1Database) {}

  initialize(): Promise<void> {
    return ensureMessagingSchema(this.db);
  }

  async getOrCreateDirectConversation(userId: string, peerUserId: string, now: number): Promise<DirectConversation> {
    await this.initialize();
    const [participantAId, participantBId] = [userId, peerUserId].sort();
    const directKey = `${participantAId}:${participantBId}`;

    await this.db
      .prepare(`
        INSERT OR IGNORE INTO conversations (
          conversation_id, participant_a_id, participant_b_id, direct_key, created_at, last_message_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
      `)
      .bind(crypto.randomUUID(), participantAId, participantBId, directKey, now)
      .run();

    const row = await this.db
      .prepare(`
        SELECT conversation_id, participant_a_id, participant_b_id, created_at, last_message_at, encryption_mode, auto_protection
        FROM conversations
        WHERE direct_key = ? AND kind = 'direct'
        LIMIT 1
      `)
      .bind(directKey)
      .first<Row>();

    if (!row) throw new Error("Direct conversation was not created");
    return mapConversation(row);
  }

  async findConversationForUser(conversationId: string, userId: string): Promise<DirectConversation | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT conversation_id, participant_a_id, participant_b_id, created_at, last_message_at, encryption_mode, auto_protection
        FROM conversations
        WHERE conversation_id = ?
          AND kind = 'direct' AND (participant_a_id = ? OR participant_b_id = ?)
        LIMIT 1
      `)
      .bind(conversationId, userId, userId)
      .first<Row>();
    return row ? mapConversation(row) : null;
  }

  async getFeatureEnabled(featureId:string):Promise<boolean>{
    await this.initialize();
    const row=await this.db.prepare('SELECT enabled FROM feature_flags WHERE feature_id=?').bind(featureId)
      .first<{enabled:number}>();
    return row ? row.enabled===1 : true;
  }

  async setFeatureEnabled(featureId:string,enabled:boolean,actorId:string):Promise<void>{
    await this.initialize();
    await this.db.prepare(`INSERT INTO feature_flags(feature_id,enabled,updated_at,updated_by_user_id)
      VALUES(?,?,?,?) ON CONFLICT(feature_id) DO UPDATE SET enabled=excluded.enabled,
      updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`)
      .bind(featureId,enabled?1:0,Date.now(),actorId).run();
  }

  async reactivateManualEncryption(conversationId:string):Promise<void>{
    await this.initialize();
    await this.db.prepare(`UPDATE conversations SET encryption_mode='protected',
      encryption_opt_out=0,auto_protection=0
      WHERE conversation_id=? AND kind='direct' AND protection_origin='manual'`)
      .bind(conversationId).run();
  }

  async setDirectEncryptionOptOut(conversationId:string,enabled:boolean):Promise<void>{
    await this.initialize();
    // Disabling encryption applies only to NEW messages. Existing ciphertext
    // is kept in place, never rewritten or destroyed.
    await this.db.prepare(`UPDATE conversations SET encryption_mode=CASE WHEN ?=1 THEN 'plain' ELSE encryption_mode END,
      auto_protection=CASE WHEN ?=1 THEN 0 ELSE auto_protection END,
      encryption_opt_out=? WHERE conversation_id=? AND kind='direct'`)
      .bind(enabled?1:0,enabled?1:0,enabled?1:0,conversationId).run();
  }

  async insertDeviceEnvelope(conversationId:string,senderUserId:string,envelope:SealedDeviceEnvelope,senderSigning:DevicePublicKey):Promise<{envelope:StoredDeviceEnvelope;created:boolean}>{
    await this.initialize();
    const id=crypto.randomUUID(),createdAt=Date.now();
    const inserted=await this.db.prepare(`INSERT OR IGNORE INTO e2ee_device_envelopes (
      envelope_id,conversation_id,sender_user_id,sender_device_id,recipient_user_id,
      recipient_device_id,client_message_id,ephemeral_public_key,nonce,ciphertext,signature,created_at,
      sender_signing_key
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id,conversationId,senderUserId,envelope.senderDeviceId,envelope.recipientUserId,
        envelope.recipientDeviceId,envelope.clientMessageId,JSON.stringify(envelope.ephemeralPublicKey),
        envelope.nonce,envelope.ciphertext,envelope.signature,createdAt,JSON.stringify(senderSigning)).run();
    const row=await this.db.prepare(`SELECT * FROM e2ee_device_envelopes WHERE conversation_id=?
      AND sender_user_id=? AND sender_device_id=? AND recipient_device_id=? AND client_message_id=?`)
      .bind(conversationId,senderUserId,envelope.senderDeviceId,envelope.recipientDeviceId,envelope.clientMessageId)
      .first<Record<string,unknown>>();
    if(!row)throw new Error('Зашифрованный конверт не сохранился.');
    const stored=this.rowEnvelope(row);
    // A retried client ID must refer to identical ciphertext and metadata.
    if(stored.ciphertext!==envelope.ciphertext||stored.signature!==envelope.signature||
       stored.nonce!==envelope.nonce||stored.recipientUserId!==envelope.recipientUserId||
       JSON.stringify(stored.ephemeralPublicKey)!==JSON.stringify(envelope.ephemeralPublicKey))
      throw new Error('ENVELOPE_IDEMPOTENCY_CONFLICT');
    return {envelope:stored,created:Number(inserted.meta?.changes??0)>0};
  }

  async listDeviceEnvelopes(conversationId:string,userId:string,deviceId:string):Promise<StoredDeviceEnvelope[]>{
    await this.initialize();
    const rows=await this.db.prepare(`SELECT * FROM e2ee_device_envelopes
      WHERE conversation_id=? AND recipient_user_id=? AND recipient_device_id=?
      AND acknowledged_at IS NULL ORDER BY created_at,envelope_id LIMIT 100`)
      .bind(conversationId,userId,deviceId).all<Record<string,unknown>>();
    return (rows.results??[]).map(row=>this.rowEnvelope(row));
  }

  async acknowledgeDeviceEnvelope(id:string,conversationId:string,userId:string,deviceId:string):Promise<boolean>{
    await this.initialize();
    const row=await this.db.prepare(`UPDATE e2ee_device_envelopes SET acknowledged_at=?
      WHERE envelope_id=? AND conversation_id=? AND recipient_user_id=?
      AND recipient_device_id=? AND acknowledged_at IS NULL`)
      .bind(Date.now(),id,conversationId,userId,deviceId).run();
    return Number(row.meta?.changes??0)===1;
  }

  private rowEnvelope(row:Record<string,unknown>):StoredDeviceEnvelope{
    return {
      version:2,envelopeId:String(row.envelope_id),conversationId:String(row.conversation_id),
      senderUserId:String(row.sender_user_id),senderDeviceId:String(row.sender_device_id),
      recipientUserId:String(row.recipient_user_id),recipientDeviceId:String(row.recipient_device_id),
      clientMessageId:String(row.client_message_id),ephemeralPublicKey:JSON.parse(String(row.ephemeral_public_key)),
      nonce:String(row.nonce),ciphertext:String(row.ciphertext),signature:String(row.signature),
      createdAt:Number(row.created_at),
      senderSigningKey:row.sender_signing_key?JSON.parse(String(row.sender_signing_key)):undefined
    };
  }

  async registerDevice(userId:string,bundle:DeviceBundle):Promise<RegisteredDevice|null>{
    await this.initialize();
    const now=Date.now();
    await this.db.prepare(`INSERT OR IGNORE INTO e2ee_devices
      (user_id,device_id,identity_signing,identity_agreement,signed_prekey,
       prekey_signature,registration_signature,trust,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,
        CASE WHEN EXISTS(SELECT 1 FROM e2ee_devices WHERE user_id=? AND trust='active')
          THEN 'pending' ELSE 'active' END,?,?)`)
      .bind(userId,bundle.deviceId,JSON.stringify(bundle.identitySigning),
        JSON.stringify(bundle.identityAgreement),JSON.stringify(bundle.signedPrekey),
        bundle.prekeySignature,bundle.registrationSignature,userId,now,now).run();
    const device=(await this.listDevices(userId,true)).find(x=>x.deviceId===bundle.deviceId);
    // A device ID cannot be rebound to different keys or revived after revocation.
    if(!device||device.trust==='revoked'||
      JSON.stringify(device.identitySigning)!==JSON.stringify(bundle.identitySigning)||
      JSON.stringify(device.identityAgreement)!==JSON.stringify(bundle.identityAgreement)||
      JSON.stringify(device.signedPrekey)!==JSON.stringify(bundle.signedPrekey)||
      device.prekeySignature!==bundle.prekeySignature||device.registrationSignature!==bundle.registrationSignature)
      return null;
    return device;
  }

  async listDevices(userId:string,includeInactive:boolean):Promise<RegisteredDevice[]>{
    await this.initialize();
    const rows=await this.db.prepare(`SELECT * FROM e2ee_devices WHERE user_id=?
      ${includeInactive?'':"AND trust='active'"} ORDER BY created_at,device_id`)
      .bind(userId).all<Record<string,unknown>>();
    return (rows.results??[]).map(row=>({
      userId:String(row.user_id),deviceId:String(row.device_id),
      identitySigning:JSON.parse(String(row.identity_signing)),
      identityAgreement:JSON.parse(String(row.identity_agreement)),
      signedPrekey:JSON.parse(String(row.signed_prekey)),
      prekeySignature:String(row.prekey_signature),
      registrationSignature:String(row.registration_signature),
      trust:String(row.trust) as RegisteredDevice['trust'],createdAt:Number(row.created_at)
    }));
  }

  async approveDevice(userId:string,deviceId:string):Promise<boolean>{
    await this.initialize();
    const result=await this.db.prepare(`UPDATE e2ee_devices SET trust='active',updated_at=?
      WHERE user_id=? AND device_id=? AND trust='pending'`)
      .bind(Date.now(),userId,deviceId).run();
    return Number(result.meta?.changes??0)===1;
  }

  async revokeDevice(userId:string,deviceId:string):Promise<boolean>{
    await this.initialize();
    const result=await this.db.prepare(`UPDATE e2ee_devices SET trust='revoked',updated_at=?
      WHERE user_id=? AND device_id=? AND trust='active'
      AND EXISTS(SELECT 1 FROM e2ee_devices WHERE user_id=? AND trust='active' AND device_id<>?)`)
      .bind(Date.now(),userId,deviceId,userId,deviceId).run();
    return Number(result.meta?.changes??0)===1;
  }

  async registerIdentityKey(userId:string,publicKey:string):Promise<boolean>{
    await this.initialize();
    await this.db.prepare('INSERT OR IGNORE INTO account_encryption_keys(user_id,public_key,created_at) VALUES(?,?,?)')
      .bind(userId,publicKey,Date.now()).run();
    const row=await this.db.prepare('SELECT public_key FROM account_encryption_keys WHERE user_id=?')
      .bind(userId).first<{public_key:string}>();
    return row?.public_key===publicKey;
  }

  async identityKeys(userIds:string[]):Promise<Map<string,string>>{
    await this.initialize();
    const result=new Map<string,string>();
    for(const id of userIds){
      const row=await this.db.prepare('SELECT public_key FROM account_encryption_keys WHERE user_id=?')
        .bind(id).first<{public_key:string}>();
      if(row)result.set(id,row.public_key);
    }
    return result;
  }

  async activateAutoProtection(conversationId:string):Promise<boolean>{
    await this.initialize();
    // Atomic mode transition. Never relabel a manually protected legacy chat.
    await this.db.prepare(`UPDATE conversations SET encryption_mode='protected',auto_protection=1
      WHERE conversation_id=? AND kind='direct' AND encryption_mode='plain' AND encryption_opt_out=0
      AND EXISTS (SELECT 1 FROM account_encryption_keys WHERE user_id=conversations.participant_a_id)
      AND EXISTS (SELECT 1 FROM account_encryption_keys WHERE user_id=conversations.participant_b_id)`)
      .bind(conversationId).run();
    const row=await this.db.prepare('SELECT auto_protection FROM conversations WHERE conversation_id=?')
      .bind(conversationId).first<{auto_protection:number}>();
    return row?.auto_protection===1;
  }

  async protectDirectConversation(conversationId:string):Promise<void> {
    await this.initialize();
    await this.db.prepare("UPDATE conversations SET encryption_mode='protected',protection_origin='manual',encryption_opt_out=0 WHERE conversation_id=? AND kind='direct'")
      .bind(conversationId).run();
  }

  async listConversationsForUser(userId: string, limit: number): Promise<DirectConversation[]> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        SELECT conversation_id, participant_a_id, participant_b_id, created_at, last_message_at, encryption_mode, auto_protection
        FROM conversations
        WHERE kind = 'direct' AND (participant_a_id = ? OR participant_b_id = ?)
        ORDER BY COALESCE(last_message_at, created_at) DESC, conversation_id DESC
        LIMIT ?
      `)
      .bind(userId, userId, limit)
      .all<Row>();
    return (result.results ?? []).map(mapConversation);
  }

  async createGroup(title: string, avatarIcon: string, ownerUserId: string, members: string[], historyMode: "all" | "since_join", now: number): Promise<GroupConversation> {
    await this.initialize();
    const conversationId = crypto.randomUUID();
    // Compatibility fields are kept only for pre-v4 direct rows. Membership is
    // exclusively controlled by group_members, never participant_a/b.
    await this.db.batch([
      this.db.prepare(`INSERT INTO conversations
        (conversation_id,participant_a_id,participant_b_id,direct_key,created_at,last_message_at,kind,title,owner_user_id,history_mode,avatar_icon)
        VALUES (?,?,?,?,?,NULL,'group',?,?,?,?)`)
        .bind(conversationId,ownerUserId,ownerUserId,`group:${conversationId}`,now,title,ownerUserId,historyMode,avatarIcon),
      ...[ownerUserId,...members].map(userId=>this.db.prepare(`INSERT INTO group_members(conversation_id,user_id,joined_at)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE conversation_id=? AND kind='group')`)
        .bind(conversationId,userId,now,conversationId))
    ]);
    return {kind:'group',conversationId,title,avatarIcon,ownerUserId,historyMode,createdAt:now,lastMessageAt:null};
  }

  async addGroupMembers(conversationId: string, userIds: string[], now: number): Promise<void> {
    await this.initialize();
    if (!userIds.length) return;
    const conversation=await this.db.prepare("SELECT last_message_at FROM conversations WHERE conversation_id=? AND kind='group'")
      .bind(conversationId).first<Row>();
    const joinedAt=Math.max(now,Number(conversation?.last_message_at??0)+1);
    await this.db.batch(userIds.map(userId=>this.db.prepare(`INSERT OR IGNORE INTO group_members(conversation_id,user_id,joined_at)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE conversation_id=? AND kind='group')`)
      .bind(conversationId,userId,joinedAt,conversationId)));
  }

  async removeGroupMember(conversationId:string,userId:string):Promise<void> {
    await this.initialize();
    await this.db.prepare('DELETE FROM group_members WHERE conversation_id=? AND user_id=?')
      .bind(conversationId,userId).run();
  }

  async listGroupMembers(conversationId: string): Promise<GroupMember[]> {
    await this.initialize();
    const result=await this.db.prepare('SELECT user_id,joined_at FROM group_members WHERE conversation_id=? ORDER BY joined_at,user_id')
      .bind(conversationId).all<Row>();
    return (result.results??[]).map(row=>({userId:String(row.user_id),joinedAt:Number(row.joined_at)}));
  }

  async findAnyConversationForUser(conversationId: string, userId: string): Promise<Conversation|null> {
    await this.initialize();
    const result=await this.db.prepare(`SELECT c.* FROM conversations c
      LEFT JOIN group_members gm ON gm.conversation_id=c.conversation_id AND gm.user_id=?
      WHERE c.conversation_id=? AND ((c.kind='direct' AND (c.participant_a_id=? OR c.participant_b_id=?))
        OR (c.kind='group' AND gm.user_id IS NOT NULL)) LIMIT 1`)
      .bind(userId,conversationId,userId,userId).first<Row>();
    return result ? (result.kind==='group'?mapGroup(result):mapConversation(result)) : null;
  }

  async listAllConversationsForUser(userId: string, limit: number): Promise<Conversation[]> {
    await this.initialize();
    const result=await this.db.prepare(`SELECT c.* FROM conversations c
      LEFT JOIN group_members gm ON gm.conversation_id=c.conversation_id AND gm.user_id=?
      WHERE (c.kind='direct' AND (c.participant_a_id=? OR c.participant_b_id=?))
         OR (c.kind='group' AND gm.user_id IS NOT NULL)
      ORDER BY COALESCE(c.last_message_at,c.created_at) DESC,c.conversation_id DESC LIMIT ?`)
      .bind(userId,userId,userId,limit).all<Row>();
    return (result.results??[]).map(row=>row.kind==='group'?mapGroup(row):mapConversation(row));
  }

  async listConversationRecipients(conversation: Conversation): Promise<string[]> {
    if ('title' in conversation) return (await this.listGroupMembers(conversation.conversationId)).map(member=>member.userId);
    return [conversation.participantAId,conversation.participantBId];
  }

  async listMessageReaders(conversationId: string,messageIds: string[]):Promise<Map<string,Array<{userId:string;readAt:number}>>> {
    await this.initialize();
    const output=new Map<string,Array<{userId:string;readAt:number}>>();
    if(!messageIds.length)return output;
    const placeholders=messageIds.map(()=>'?').join(',');
    const rows=await this.db.prepare(`SELECT message_id,recipient_user_id,read_at FROM message_receipts
      WHERE message_id IN (${placeholders}) AND read_at IS NOT NULL`).bind(...messageIds).all<Row>();
    for(const row of rows.results??[]){const key=String(row.message_id);const current=output.get(key)??[];
      current.push({userId:String(row.recipient_user_id),readAt:Number(row.read_at)});output.set(key,current);}
    return output;
  }

  async listMessages(conversationId: string, limit: number, viewerUserId: string): Promise<StoredMessage[]> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}, c.kind AS conversation_kind,
          own_rc.read_at AS own_read_at, own_rc.delivered_at AS own_delivered_at
        FROM messages m
        ${MESSAGE_JOINS}
        LEFT JOIN message_receipts own_rc ON own_rc.message_id=m.message_id AND own_rc.recipient_user_id=?
        JOIN conversations c ON c.conversation_id=m.conversation_id
        LEFT JOIN group_members gm ON gm.conversation_id=c.conversation_id AND gm.user_id=?
        WHERE m.conversation_id = ?
        AND (c.kind='direct' OR (gm.user_id IS NOT NULL AND
          (c.history_mode='all' OR m.created_at>=gm.joined_at)))
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT ?
      `)
      .bind(viewerUserId,viewerUserId,viewerUserId,viewerUserId,conversationId, limit)
      .all<Row>();
    return (result.results ?? []).map((row) => mapMessage(row, viewerUserId)).reverse();
  }

  async insertMessage(input: StoredMessage): Promise<InsertMessageResult> {
    await this.initialize();

    const existing = await this.findByClientMessageId(input.senderUserId, input.clientMessageId);
    if (existing) return sameMessage(existing, input) ? { status: "duplicate", message: existing } : { status: "conflict" };

    const statements = [
      this.db
        .prepare(`
          INSERT OR IGNORE INTO messages (
            message_id, conversation_id, sender_user_id, client_message_id, message_type, body, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          input.messageId,
          input.conversationId,
          input.senderUserId,
          input.clientMessageId,
          input.kind,
          input.text,
          input.createdAt
        )
    ];

    if (input.kind === "voice" && input.voice) {
      statements.push(
        this.db
          .prepare(`
            INSERT OR IGNORE INTO voice_message_attachments (
              message_id, object_key, duration_ms, mime_type, bitrate_bps, size_bytes
            )
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM messages WHERE message_id = ? AND message_type = 'voice'
            )
          `)
          .bind(
            input.messageId,
            input.voice.objectKey,
            input.voice.durationMs,
            input.voice.mimeType,
            input.voice.bitrateBps,
            input.voice.sizeBytes,
            input.messageId
          )
      );
    }

    statements.push(
      this.db
        .prepare(`
          UPDATE conversations
          SET last_message_at = CASE
            WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
            ELSE last_message_at
          END
          WHERE conversation_id = ?
            AND EXISTS (SELECT 1 FROM messages WHERE message_id = ?)
        `)
        .bind(input.createdAt, input.createdAt, input.conversationId, input.messageId)
    );

    const results = await this.db.batch(statements);
    if ((results[0]?.meta?.changes ?? 0) === 1) {
      return { status: "created", message: input };
    }

    const afterRace = await this.findByClientMessageId(input.senderUserId, input.clientMessageId);
    if (afterRace && sameMessage(afterRace, input)) {
      return { status: "duplicate", message: afterRace };
    }
    return { status: "conflict" };
  }

  async markMessagesDelivered(
    conversationId: string,
    recipientUserId: string,
    messageIds: string[],
    now: number
  ): Promise<DeliveryReceiptUpdate[]> {
    await this.initialize();
    if (!messageIds.length) return [];

    const placeholders = messageIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}, own_rc.read_at AS own_read_at,
          own_rc.delivered_at AS own_delivered_at, c.kind AS conversation_kind
        FROM messages m
        ${MESSAGE_JOINS}
        JOIN conversations c ON c.conversation_id=m.conversation_id
        LEFT JOIN message_receipts own_rc ON own_rc.message_id=m.message_id AND own_rc.recipient_user_id=?
        LEFT JOIN group_members gm ON gm.conversation_id=c.conversation_id AND gm.user_id=?
        WHERE m.conversation_id = ?
          AND m.message_id IN (${placeholders})
          AND m.sender_user_id <> ?
          AND (c.kind='direct' OR (gm.user_id IS NOT NULL AND (c.history_mode='all' OR m.created_at>=gm.joined_at)))
      `)
      .bind(recipientUserId,recipientUserId,recipientUserId,recipientUserId,conversationId, ...messageIds, recipientUserId)
      .all<Row>();

    const messages = (result.results ?? []).map((row) => mapMessage(row, recipientUserId));
    const pending = messages.filter((message) => message.deliveredAt === null);
    if (pending.length) {
      await this.db.batch(
        pending.map((message) =>
          this.db
            .prepare(`
              INSERT INTO message_receipts (message_id, recipient_user_id, delivered_at, read_at)
              VALUES (?, ?, ?, NULL)
              ON CONFLICT(message_id, recipient_user_id) DO UPDATE SET
                delivered_at = COALESCE(message_receipts.delivered_at, excluded.delivered_at)
            `)
            .bind(message.messageId, recipientUserId, now)
        )
      );
    }

    return messages.map((message) => ({
      changed: message.deliveredAt === null,
      message: {
        ...message,
        deliveredAt: message.deliveredAt ?? now
      }
    }));
  }

  async markMessagesRead(
    conversationId: string,
    recipientUserId: string,
    messageIds: string[],
    now: number
  ): Promise<DeliveryReceiptUpdate[]> {
    await this.initialize();
    if (!messageIds.length) return [];

    const placeholders = messageIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}, own_rc.read_at AS own_read_at,
          own_rc.delivered_at AS own_delivered_at, c.kind AS conversation_kind
        FROM messages m
        ${MESSAGE_JOINS}
        JOIN conversations c ON c.conversation_id=m.conversation_id
        LEFT JOIN message_receipts own_rc ON own_rc.message_id=m.message_id AND own_rc.recipient_user_id=?
        LEFT JOIN group_members gm ON gm.conversation_id=c.conversation_id AND gm.user_id=?
        WHERE m.conversation_id = ?
          AND m.message_id IN (${placeholders})
          AND m.sender_user_id <> ?
          AND (c.kind='direct' OR (gm.user_id IS NOT NULL AND (c.history_mode='all' OR m.created_at>=gm.joined_at)))
      `)
      .bind(recipientUserId,recipientUserId,recipientUserId,recipientUserId,conversationId, ...messageIds, recipientUserId)
      .all<Row>();

    const messages = (result.results ?? []).map((row) => mapMessage(row, recipientUserId));
    const pending = messages.filter((message) => message.readAt === null);
    if (pending.length) {
      await this.db.batch(
        pending.map((message) =>
          this.db
            .prepare(`
              INSERT INTO message_receipts (message_id, recipient_user_id, delivered_at, read_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(message_id, recipient_user_id) DO UPDATE SET
                delivered_at = COALESCE(message_receipts.delivered_at, excluded.delivered_at),
                read_at = COALESCE(message_receipts.read_at, excluded.read_at)
            `)
            .bind(message.messageId, recipientUserId, message.deliveredAt ?? now, now)
        )
      );
    }

    return messages.map((message) => ({
      changed: message.readAt === null,
      message: {
        ...message,
        deliveredAt: message.deliveredAt ?? now,
        readAt: message.readAt ?? now
      }
    }));
  }

  async findLatestMessage(conversationId: string): Promise<StoredMessage | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        ${MESSAGE_JOINS}
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 1
      `)
      .bind(null,null,conversationId)
      .first<Row>();
    return row ? mapMessage(row) : null;
  }

  async findMessageForUser(conversationId: string, messageId: string, userId: string): Promise<StoredMessage | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        ${MESSAGE_JOINS}
        JOIN conversations c ON c.conversation_id = m.conversation_id
        LEFT JOIN group_members gm ON gm.conversation_id=c.conversation_id AND gm.user_id=?
        WHERE m.conversation_id = ?
          AND m.message_id = ?
          AND ((c.kind='direct' AND (c.participant_a_id = ? OR c.participant_b_id = ?))
            OR (c.kind='group' AND gm.user_id IS NOT NULL AND
              (c.history_mode='all' OR m.created_at>=gm.joined_at)))
        LIMIT 1
      `)
      .bind(userId,userId,userId, conversationId, messageId, userId, userId)
      .first<Row>();
    return row ? mapMessage(row, userId) : null;
  }

  async updateVoiceListening(
    conversationId: string,
    messageId: string,
    listenerUserId: string,
    heardRanges: Array<[number, number]>,
    resumeMs: number,
    completed: boolean,
    now: number
  ): Promise<VoiceListenUpdate | null> {
    await this.initialize();
    const message = await this.findMessageForUser(conversationId, messageId, listenerUserId);
    if (!message || message.kind !== "voice" || !message.voice || message.senderUserId === listenerUserId) return null;

    const existingRanges = message.voice.progress?.heardRanges ?? [];
    const mergedRanges = mergeRanges([...existingRanges, ...heardRanges], message.voice.durationMs);
    const listenedMs = mergedRanges.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
    const cappedResumeMs = Math.min(Math.max(0, resumeMs), message.voice.durationMs);
    const completedAt = completed && listenedMs >= Math.max(0, message.voice.durationMs - 1500) ? now : null;

    await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO voice_listen_receipts (
            message_id, listener_user_id, listened_ms, resume_ms, heard_ranges, completed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id, listener_user_id) DO UPDATE SET
            listened_ms = excluded.listened_ms,
            resume_ms = excluded.resume_ms,
            heard_ranges = excluded.heard_ranges,
            completed_at = COALESCE(voice_listen_receipts.completed_at, excluded.completed_at),
            updated_at = excluded.updated_at
        `)
        .bind(messageId, listenerUserId, listenedMs, cappedResumeMs, JSON.stringify(mergedRanges), completedAt, now),
      this.db
        .prepare(`
          INSERT INTO message_receipts (message_id, recipient_user_id, delivered_at, read_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(message_id, recipient_user_id) DO UPDATE SET
            delivered_at = COALESCE(message_receipts.delivered_at, excluded.delivered_at),
            read_at = COALESCE(message_receipts.read_at, excluded.read_at)
        `)
        .bind(messageId, listenerUserId, now, now)
    ]);

    const updated = await this.findMessageForUser(conversationId, messageId, listenerUserId);
    if (!updated?.voice?.progress) return null;
    return { message: updated, progress: updated.voice.progress };
  }

  async getVoiceListeningShare(userId: string): Promise<boolean> {
    await this.initialize();
    const row = await this.db
      .prepare("SELECT share_progress FROM voice_privacy_settings WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<Row>();
    return row ? Number(row.share_progress) === 1 : true;
  }

  async setVoiceListeningShare(userId: string, share: boolean, now: number): Promise<void> {
    await this.initialize();
    await this.db
      .prepare(`
        INSERT INTO voice_privacy_settings (user_id, share_progress, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          share_progress = excluded.share_progress,
          updated_at = excluded.updated_at
      `)
      .bind(userId, share ? 1 : 0, now)
      .run();
  }

  async deleteDataForUsers(userIds: string[]): Promise<void> {
    await this.initialize();
    if (!userIds.length) return;

    for (const userId of userIds) {
      await this.db.prepare("DELETE FROM e2ee_device_envelopes WHERE sender_user_id=? OR recipient_user_id=?")
        .bind(userId,userId).run();
      await this.db.prepare("DELETE FROM e2ee_devices WHERE user_id = ?").bind(userId).run();
      await this.db.prepare("DELETE FROM account_encryption_keys WHERE user_id = ?").bind(userId).run();
      await this.db.prepare("DELETE FROM group_members WHERE user_id = ?").bind(userId).run();
      await this.db.prepare("DELETE FROM voice_privacy_settings WHERE user_id = ?").bind(userId).run();
      await this.db.prepare("DELETE FROM voice_listen_receipts WHERE listener_user_id = ?").bind(userId).run();
    }

    const conversationIds = new Set<string>();
    for (const userId of userIds) {
      const result = await this.db
        .prepare(`
          SELECT conversation_id
          FROM conversations
          WHERE (kind='direct' AND (participant_a_id = ? OR participant_b_id = ?))
             OR (kind='group' AND owner_user_id = ?)
        `)
        .bind(userId, userId, userId)
        .all<Row>();
      for (const row of result.results ?? []) conversationIds.add(String(row.conversation_id));
    }

    if (!conversationIds.size) return;
    const statements = [];
    for (const conversationId of conversationIds) {
      statements.push(
        this.db
          .prepare("DELETE FROM message_receipts WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)")
          .bind(conversationId)
      );
      statements.push(this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(conversationId));
      statements.push(this.db.prepare("DELETE FROM conversations WHERE conversation_id = ?").bind(conversationId));
    }
    await this.db.batch(statements);
  }

  private async findByClientMessageId(senderUserId: string, clientMessageId: string): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        ${MESSAGE_JOINS}
        WHERE m.sender_user_id = ? AND m.client_message_id = ?
        LIMIT 1
      `)
      .bind(senderUserId,senderUserId,senderUserId, clientMessageId)
      .first<Row>();
    return row ? mapMessage(row) : null;
  }
}

function mapGroup(row: Row): GroupConversation {
  return {kind:'group',conversationId:String(row.conversation_id),title:String(row.title),avatarIcon:String(row.avatar_icon??'👥'),
    ownerUserId:String(row.owner_user_id),historyMode:row.history_mode==='since_join'?'since_join':'all',
    createdAt:Number(row.created_at),lastMessageAt:row.last_message_at==null?null:Number(row.last_message_at)};
}

function mapConversation(row: Row): DirectConversation {
  return {
    encryptionMode:row.encryption_mode==='protected'?'protected':'plain',
    autoProtection:Number(row.auto_protection??0)===1,
    encryptionOptOut:Number(row.encryption_opt_out??0)===1,
    protectionOrigin:row.protection_origin==='manual'?'manual':row.protection_origin==='auto'?'auto':'none',
    conversationId: String(row.conversation_id),
    participantAId: String(row.participant_a_id),
    participantBId: String(row.participant_b_id),
    createdAt: Number(row.created_at),
    lastMessageAt: row.last_message_at === null ? null : Number(row.last_message_at)
  };
}

function mapMessage(row: Row, viewerUserId?: string): StoredMessage {
  const kind = row.message_type === "voice" ? "voice" : "text";
  const senderUserId = String(row.sender_user_id);
  const listenerUserId = row.listener_user_id == null ? null : String(row.listener_user_id);
  const shareProgress = Number(row.share_progress ?? 1) === 1;
  const viewerMaySeeProgress = Boolean(
    listenerUserId && viewerUserId &&
    (viewerUserId === listenerUserId || (viewerUserId === senderUserId && shareProgress))
  );

  const progress = viewerMaySeeProgress && row.voice_updated_at != null
    ? {
        listenedMs: Number(row.listened_ms ?? 0),
        resumeMs: Number(row.resume_ms ?? 0),
        completedAt: row.completed_at == null ? null : Number(row.completed_at),
        updatedAt: Number(row.voice_updated_at),
        ...(viewerUserId === listenerUserId ? { heardRanges: parseRanges(row.heard_ranges) } : {})
      }
    : null;

  return {
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    senderUserId,
    clientMessageId: String(row.client_message_id),
    kind,
    text: String(row.body),
    voice: kind === "voice" && row.object_key != null
      ? {
          objectKey: String(row.object_key),
          durationMs: Number(row.duration_ms),
          mimeType: String(row.mime_type),
          bitrateBps: Number(row.bitrate_bps),
          sizeBytes: Number(row.size_bytes),
          progress
        }
      : null,
    createdAt: Number(row.created_at),
    deliveredAt: row.conversation_kind==='group' && viewerUserId!==senderUserId
      ? row.own_delivered_at==null?null:Number(row.own_delivered_at)
      : row.delivered_at==null?null:Number(row.delivered_at),
    readAt: row.conversation_kind==='group' && viewerUserId!==senderUserId
      ? row.own_read_at==null?null:Number(row.own_read_at)
      : row.read_at==null?null:Number(row.read_at)
  };
}

function sameMessage(existing: StoredMessage, input: StoredMessage): boolean {
  if (
    existing.conversationId !== input.conversationId ||
    existing.kind !== input.kind ||
    existing.text !== input.text
  ) return false;

  if (existing.kind === "text") return true;
  if (!existing.voice || !input.voice) return false;
  return existing.voice.objectKey === input.voice.objectKey &&
    existing.voice.durationMs === input.voice.durationMs &&
    existing.voice.mimeType === input.voice.mimeType &&
    existing.voice.bitrateBps === input.voice.bitrateBps &&
    existing.voice.sizeBytes === input.voice.sizeBytes;
}

function parseRanges(value: unknown): Array<[number, number]> {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((range) => Array.isArray(range) && range.length === 2 && Number.isFinite(Number(range[0])) && Number.isFinite(Number(range[1])))
      .map((range) => [Number(range[0]), Number(range[1])] as [number, number]);
  } catch {
    return [];
  }
}

function mergeRanges(ranges: Array<[number, number]>, durationMs: number): Array<[number, number]> {
  const normalized = ranges
    .map(([start, end]) => [
      Math.max(0, Math.min(durationMs, Math.round(start))),
      Math.max(0, Math.min(durationMs, Math.round(end)))
    ] as [number, number])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1] + 250) {
      merged.push([...range] as [number, number]);
    } else {
      last[1] = Math.max(last[1], range[1]);
    }
  }
  return merged.slice(0, 256);
}
