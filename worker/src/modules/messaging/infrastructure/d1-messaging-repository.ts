import type { D1Database } from "../../../platform/cloudflare";
import type {
  DeliveryReceiptUpdate,
  DirectConversation,
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
  LEFT JOIN voice_listen_receipts vl ON vl.message_id = m.message_id
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
        INSERT OR IGNORE INTO direct_conversations (
          conversation_id, participant_a_id, participant_b_id, direct_key, created_at, last_message_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
      `)
      .bind(crypto.randomUUID(), participantAId, participantBId, directKey, now)
      .run();

    const row = await this.db
      .prepare(`
        SELECT conversation_id, participant_a_id, participant_b_id, created_at, last_message_at
        FROM direct_conversations
        WHERE direct_key = ?
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
        SELECT conversation_id, participant_a_id, participant_b_id, created_at, last_message_at
        FROM direct_conversations
        WHERE conversation_id = ?
          AND (participant_a_id = ? OR participant_b_id = ?)
        LIMIT 1
      `)
      .bind(conversationId, userId, userId)
      .first<Row>();
    return row ? mapConversation(row) : null;
  }

  async listConversationsForUser(userId: string, limit: number): Promise<DirectConversation[]> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        SELECT conversation_id, participant_a_id, participant_b_id, created_at, last_message_at
        FROM direct_conversations
        WHERE participant_a_id = ? OR participant_b_id = ?
        ORDER BY COALESCE(last_message_at, created_at) DESC, conversation_id DESC
        LIMIT ?
      `)
      .bind(userId, userId, limit)
      .all<Row>();
    return (result.results ?? []).map(mapConversation);
  }

  async listMessages(conversationId: string, limit: number, viewerUserId: string): Promise<StoredMessage[]> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        ${MESSAGE_JOINS}
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT ?
      `)
      .bind(conversationId, limit)
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
          UPDATE direct_conversations
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
        SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        ${MESSAGE_JOINS}
        WHERE m.conversation_id = ?
          AND m.message_id IN (${placeholders})
          AND m.sender_user_id <> ?
      `)
      .bind(conversationId, ...messageIds, recipientUserId)
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
      .bind(conversationId)
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
        JOIN direct_conversations c ON c.conversation_id = m.conversation_id
        WHERE m.conversation_id = ?
          AND m.message_id = ?
          AND (c.participant_a_id = ? OR c.participant_b_id = ?)
        LIMIT 1
      `)
      .bind(conversationId, messageId, userId, userId)
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
      await this.db.prepare("DELETE FROM voice_privacy_settings WHERE user_id = ?").bind(userId).run();
      await this.db.prepare("DELETE FROM voice_listen_receipts WHERE listener_user_id = ?").bind(userId).run();
    }

    const conversationIds = new Set<string>();
    for (const userId of userIds) {
      const result = await this.db
        .prepare(`
          SELECT conversation_id
          FROM direct_conversations
          WHERE participant_a_id = ? OR participant_b_id = ?
        `)
        .bind(userId, userId)
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
      statements.push(this.db.prepare("DELETE FROM direct_conversations WHERE conversation_id = ?").bind(conversationId));
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
      .bind(senderUserId, clientMessageId)
      .first<Row>();
    return row ? mapMessage(row) : null;
  }
}

function mapConversation(row: Row): DirectConversation {
  return {
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
    deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at)
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
