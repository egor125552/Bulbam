import type { D1Database } from "../../../platform/cloudflare";
import { ensureCallsSchema } from "./schema";

export type CallStatus = "ringing" | "accepted" | "declined" | "ended";

export interface StoredCall {
  callId: string;
  conversationId: string;
  callerUserId: string;
  calleeUserId: string;
  status: CallStatus;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endedByUserId: string | null;
}

export interface StoredCallSignal {
  sequence: number;
  callId: string;
  senderUserId: string;
  kind: "offer" | "answer" | "ice";
  payload: unknown;
  createdAt: number;
}

interface CallRow {
  call_id: string;
  conversation_id: string;
  caller_user_id: string;
  callee_user_id: string;
  status: string;
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
  ended_by_user_id: string | null;
}

export class D1CallRepository {
  constructor(private readonly db: D1Database) {}

  initialize(): Promise<void> {
    return ensureCallsSchema(this.db);
  }

  async expireStale(now: number): Promise<void> {
    await this.initialize();
    await this.db
      .prepare(
        `UPDATE calls
         SET status = 'ended', ended_at = ?, ended_by_user_id = NULL
         WHERE (status = 'ringing' AND created_at < ?)
            OR (status = 'accepted' AND answered_at IS NOT NULL AND answered_at < ?)`
      )
      .bind(now, now - 90_000, now - 8 * 60 * 60 * 1000)
      .run();
  }

  async hasActiveCall(userIds: string[]): Promise<boolean> {
    await this.initialize();
    if (!userIds.length) return false;
    const placeholders = userIds.map(() => "?").join(",");
    const bindings = [...userIds, ...userIds];
    const row = await this.db
      .prepare(
        `SELECT call_id FROM calls
         WHERE status IN ('ringing', 'accepted')
           AND (caller_user_id IN (${placeholders}) OR callee_user_id IN (${placeholders}))
         LIMIT 1`
      )
      .bind(...bindings)
      .first<{ call_id: string }>();
    return Boolean(row);
  }

  async insert(call: StoredCall): Promise<void> {
    await this.initialize();
    const result = await this.db
      .prepare(
        `INSERT INTO calls(
          call_id, conversation_id, caller_user_id, callee_user_id, status,
          created_at, answered_at, ended_at, ended_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        call.callId,
        call.conversationId,
        call.callerUserId,
        call.calleeUserId,
        call.status,
        call.createdAt,
        call.answeredAt,
        call.endedAt,
        call.endedByUserId
      )
      .run();
    if (result.success === false) throw new Error(result.error ?? "Unable to create call");
  }

  async find(callId: string): Promise<StoredCall | null> {
    await this.initialize();
    const row = await this.db
      .prepare(
        `SELECT call_id, conversation_id, caller_user_id, callee_user_id, status,
                created_at, answered_at, ended_at, ended_by_user_id
         FROM calls WHERE call_id = ?`
      )
      .bind(callId)
      .first<CallRow>();
    return row ? mapCall(row) : null;
  }

  async transition(
    callId: string,
    fromStatuses: CallStatus[],
    status: CallStatus,
    actorUserId: string,
    now: number
  ): Promise<StoredCall | null> {
    await this.initialize();
    const placeholders = fromStatuses.map(() => "?").join(",");
    const answerFields = status === "accepted"
      ? "answered_at = ?, ended_at = NULL, ended_by_user_id = NULL"
      : status === "declined" || status === "ended"
        ? "ended_at = ?, ended_by_user_id = ?"
        : "ended_at = NULL, ended_by_user_id = NULL";
    const extraValues = status === "accepted" ? [now] : [now, actorUserId];
    const result = await this.db
      .prepare(
        `UPDATE calls SET status = ?, ${answerFields}
         WHERE call_id = ? AND status IN (${placeholders})`
      )
      .bind(status, ...extraValues, callId, ...fromStatuses)
      .run();
    if ((result.meta?.changes ?? 0) < 1) return null;
    return this.find(callId);
  }

  async insertSignal(
    callId: string,
    senderUserId: string,
    kind: StoredCallSignal["kind"],
    payload: unknown,
    now: number
  ): Promise<StoredCallSignal> {
    await this.initialize();
    const result = await this.db
      .prepare(
        "INSERT INTO call_signals(call_id, sender_user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(callId, senderUserId, kind, JSON.stringify(payload), now)
      .run();
    if (result.success === false) throw new Error(result.error ?? "Unable to store call signal");

    const row = await this.db
      .prepare(
        `SELECT sequence, call_id, sender_user_id, kind, payload, created_at
         FROM call_signals
         WHERE call_id = ? AND sender_user_id = ?
         ORDER BY sequence DESC LIMIT 1`
      )
      .bind(callId, senderUserId)
      .first<{
        sequence: number;
        call_id: string;
        sender_user_id: string;
        kind: string;
        payload: string;
        created_at: number;
      }>();
    if (!row) throw new Error("Stored call signal was not found");
    return mapSignal(row);
  }

  async listSignals(callId: string, afterSequence: number, limit = 100): Promise<StoredCallSignal[]> {
    await this.initialize();
    const rows = await this.db
      .prepare(
        `SELECT sequence, call_id, sender_user_id, kind, payload, created_at
         FROM call_signals
         WHERE call_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      )
      .bind(callId, afterSequence, limit)
      .all<{
        sequence: number;
        call_id: string;
        sender_user_id: string;
        kind: string;
        payload: string;
        created_at: number;
      }>();
    return (rows.results ?? []).map(mapSignal);
  }

  async deleteSignals(callId: string): Promise<void> {
    await this.initialize();
    await this.db.prepare("DELETE FROM call_signals WHERE call_id = ?").bind(callId).run();
  }
}

function mapCall(row: CallRow): StoredCall {
  return {
    callId: row.call_id,
    conversationId: row.conversation_id,
    callerUserId: row.caller_user_id,
    calleeUserId: row.callee_user_id,
    status: row.status as CallStatus,
    createdAt: Number(row.created_at),
    answeredAt: row.answered_at === null ? null : Number(row.answered_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    endedByUserId: row.ended_by_user_id
  };
}

function mapSignal(row: {
  sequence: number;
  call_id: string;
  sender_user_id: string;
  kind: string;
  payload: string;
  created_at: number;
}): StoredCallSignal {
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload); } catch {}
  return {
    sequence: Number(row.sequence),
    callId: row.call_id,
    senderUserId: row.sender_user_id,
    kind: row.kind as StoredCallSignal["kind"],
    payload,
    createdAt: Number(row.created_at)
  };
}
