import type { D1Database } from "../../../platform/cloudflare";
import type { DeliveryReceiptUpdate, DirectConversation, StoredMessage } from "../domain/models";
import type { InsertMessageResult, MessagingRepository } from "../ports/messaging-repository";
import { ensureMessagingSchema } from "./schema";

type Row = Record<string, unknown>;

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

  async listMessages(conversationId: string, limit: number): Promise<StoredMessage[]> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        SELECT
          m.message_id,
          m.conversation_id,
          m.sender_user_id,
          m.client_message_id,
          m.body,
          m.created_at,
          (
            SELECT r.delivered_at
            FROM message_receipts r
            WHERE r.message_id = m.message_id
            ORDER BY r.delivered_at DESC
            LIMIT 1
          ) AS delivered_at
        FROM messages m
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT ?
      `)
      .bind(conversationId, limit)
      .all<Row>();
    return (result.results ?? []).map(mapMessage).reverse();
  }

  async insertMessage(input: StoredMessage): Promise<InsertMessageResult> {
    await this.initialize();

    const existing = await this.findByClientMessageId(input.senderUserId, input.clientMessageId);
    if (existing) return sameMessage(existing, input) ? { status: "duplicate", message: existing } : { status: "conflict" };

    const results = await this.db.batch([
      this.db
        .prepare(`
          INSERT OR IGNORE INTO messages (
            message_id, conversation_id, sender_user_id, client_message_id, body, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(
          input.messageId,
          input.conversationId,
          input.senderUserId,
          input.clientMessageId,
          input.text,
          input.createdAt
        ),
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
    ]);

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
        SELECT
          m.message_id,
          m.conversation_id,
          m.sender_user_id,
          m.client_message_id,
          m.body,
          m.created_at,
          (
            SELECT r.delivered_at
            FROM message_receipts r
            WHERE r.message_id = m.message_id
              AND r.recipient_user_id = ?
            LIMIT 1
          ) AS delivered_at
        FROM messages m
        WHERE m.conversation_id = ?
          AND m.message_id IN (${placeholders})
          AND m.sender_user_id <> ?
      `)
      .bind(recipientUserId, conversationId, ...messageIds, recipientUserId)
      .all<Row>();

    const messages = (result.results ?? []).map(mapMessage);
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
        SELECT
          m.message_id,
          m.conversation_id,
          m.sender_user_id,
          m.client_message_id,
          m.body,
          m.created_at,
          (
            SELECT r.delivered_at
            FROM message_receipts r
            WHERE r.message_id = m.message_id
            ORDER BY r.delivered_at DESC
            LIMIT 1
          ) AS delivered_at
        FROM messages m
        WHERE m.conversation_id = ?
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 1
      `)
      .bind(conversationId)
      .first<Row>();
    return row ? mapMessage(row) : null;
  }

  async deleteDataForUsers(userIds: string[]): Promise<void> {
    await this.initialize();
    if (!userIds.length) return;

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
        SELECT
          m.message_id,
          m.conversation_id,
          m.sender_user_id,
          m.client_message_id,
          m.body,
          m.created_at,
          (
            SELECT r.delivered_at
            FROM message_receipts r
            WHERE r.message_id = m.message_id
            ORDER BY r.delivered_at DESC
            LIMIT 1
          ) AS delivered_at
        FROM messages m
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

function mapMessage(row: Row): StoredMessage {
  return {
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    senderUserId: String(row.sender_user_id),
    clientMessageId: String(row.client_message_id),
    text: String(row.body),
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at)
  };
}

function sameMessage(existing: StoredMessage, input: StoredMessage): boolean {
  return existing.conversationId === input.conversationId && existing.text === input.text;
}
