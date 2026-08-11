import type { DurableObjectState, Env } from "../../../platform/cloudflare";
import { DurableObjectRealtime } from "../../realtime/public";

export type CallStatus = "ringing" | "accepted" | "declined" | "ended";
export interface CallPeerSnapshot { userId: string; username: string; displayName: string; }
export interface CallRoomRecord {
  callId: string;
  conversationId: string;
  callerUserId: string;
  calleeUserId: string;
  caller: CallPeerSnapshot;
  callee: CallPeerSnapshot;
  status: CallStatus;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endedByUserId: string | null;
}
export interface CallRoomSignal {
  sequence: number;
  callId: string;
  senderUserId: string;
  kind: "offer" | "answer" | "ice" | "resume";
  payload: unknown;
  createdAt: number;
}

const CALL_KEY = "activeCall";
const SIGNALS_KEY = "signals";
const RINGING_TTL_MS = 2 * 60 * 1000;
const ACCEPTED_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SIGNALS = 128;

export class CallRoom {
  private readonly realtime: DurableObjectRealtime;
  constructor(private readonly state: DurableObjectState, env: Env) {
    this.realtime = new DurableObjectRealtime(env.REALTIME);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") return this.start(await readObject(request));
      if (request.method === "GET" && url.pathname === "/call") {
        return this.getCall(url.searchParams.get("callId") ?? "", url.searchParams.get("viewerUserId") ?? "");
      }
      if (request.method === "POST" && url.pathname === "/transition") return this.transition(await readObject(request));
      if (request.method === "POST" && url.pathname === "/signal") return this.signal(await readObject(request));
      if (request.method === "GET" && url.pathname === "/signals") {
        return this.signals(
          url.searchParams.get("callId") ?? "",
          url.searchParams.get("viewerUserId") ?? "",
          Number(url.searchParams.get("after") ?? "0")
        );
      }
      return result({ ok: false, error: { code: "not_found", message: "CallRoom route not found" } }, 404);
    } catch (error) {
      console.error("[CallRoom] internal failure", error);
      return result({ ok: false, error: { code: "call_room_failure", message: "CallRoom internal failure" } }, 500);
    }
  }

  private async start(body: Record<string, unknown>): Promise<Response> {
    const incoming = asCall(body.call);
    if (!incoming) return invalid("invalid_call", "Некорректное состояние звонка.");
    const current = await this.current();
    if (current && isActive(current)) {
      return result({ ok: false, error: { code: "call_busy", message: "В этом диалоге уже есть активный звонок." } }, 409);
    }
    const call: CallRoomRecord = {
      ...incoming,
      status: "ringing",
      updatedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
      endedByUserId: null
    };
    await Promise.all([
      this.state.storage.put(CALL_KEY, call),
      this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
    ]);
    await this.syncActivePointers(call);
    await this.realtime.publishToUsers([call.calleeUserId], {
      type: "call.ringing",
      call: publicCall(call, call.calleeUserId)
    });
    return result({ ok: true, call });
  }

  private async getCall(callId: string, viewerUserId: string): Promise<Response> {
    const call = await this.current();
    if (!call || call.callId !== callId || !participant(call, viewerUserId)) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }
    return result({ ok: true, call: publicCall(call, viewerUserId) });
  }

  private async transition(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const action = stringValue(body.action);
    const call = await this.current();
    if (!call || call.callId !== callId || !participant(call, actorUserId)) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }

    if (action === "answer") {
      if (actorUserId !== call.calleeUserId) return forbidden("call_answer_forbidden", "Ответить может только получатель звонка.");
      if (call.status !== "ringing") return conflictResponse("call_not_ringing", "Звонок уже не ожидает ответа.");
      const now = Date.now();
      const updated: CallRoomRecord = { ...call, status: "accepted", answeredAt: now, updatedAt: now };
      await this.state.storage.put(CALL_KEY, updated);
      await this.syncActivePointers(updated);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.answered",
        callId: updated.callId,
        conversationId: updated.conversationId,
        answeredAt: updated.answeredAt
      });
      return result({ ok: true, call: publicCall(updated, actorUserId) });
    }

    if (action === "decline") {
      if (actorUserId !== call.calleeUserId) return forbidden("call_decline_forbidden", "Отклонить может только получатель звонка.");
      if (call.status !== "ringing") return conflictResponse("call_not_ringing", "Звонок уже не ожидает ответа.");
      const updated = endRecord(call, "declined", actorUserId);
      await Promise.all([
        this.state.storage.put(CALL_KEY, updated),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.clearActivePointers(updated);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.declined",
        callId: updated.callId,
        conversationId: updated.conversationId,
        endedAt: updated.endedAt
      });
      return result({ ok: true, call: publicCall(updated, actorUserId) });
    }

    if (action === "end") {
      if (!isActive(call)) return result({ ok: true, call: publicCall(call, actorUserId) });
      const updated = endRecord(call, "ended", actorUserId);
      await Promise.all([
        this.state.storage.put(CALL_KEY, updated),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.clearActivePointers(updated);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.ended",
        callId: updated.callId,
        conversationId: updated.conversationId,
        endedAt: updated.endedAt,
        endedByUserId: updated.endedByUserId
      });
      return result({ ok: true, call: publicCall(updated, actorUserId) });
    }
    return invalid("invalid_call_action", "Неизвестное действие звонка.");
  }

  private async signal(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const kind = stringValue(body.kind);
    const call = await this.current();
    if (!call || call.callId !== callId || !participant(call, actorUserId)) return notFoundResponse();
    if (call.status !== "accepted") return conflictResponse("call_not_accepted", "Сигналы разрешены только после ответа.");
    if (kind !== "offer" && kind !== "answer" && kind !== "ice" && kind !== "resume") {
      return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
    }
    if (kind === "offer" && actorUserId !== call.callerUserId) return forbidden("call_offer_forbidden", "Offer создаёт инициатор звонка.");
    if (kind === "answer" && actorUserId !== call.calleeUserId) return forbidden("call_answer_signal_forbidden", "Answer создаёт получатель звонка.");
    if (kind === "resume" && actorUserId !== call.calleeUserId) return forbidden("call_resume_forbidden", "Resume запрашивает получатель звонка.");

    const currentSignals = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    const now = Date.now();
    const signal: CallRoomSignal = {
      sequence: (currentSignals.at(-1)?.sequence ?? 0) + 1,
      callId,
      senderUserId: actorUserId,
      kind,
      payload: body.payload,
      createdAt: now
    };
    await Promise.all([
      this.state.storage.put(SIGNALS_KEY, [...currentSignals, signal].slice(-MAX_SIGNALS)),
      this.state.storage.put(CALL_KEY, { ...call, updatedAt: now })
    ]);
    const recipientUserId = actorUserId === call.callerUserId ? call.calleeUserId : call.callerUserId;
    await this.realtime.publishToUsers([recipientUserId], {
      type: "call.signal",
      callId,
      conversationId: call.conversationId,
      signal
    });
    return result({ ok: true, signal }, 201);
  }

  private async signals(callId: string, viewerUserId: string, after: number): Promise<Response> {
    const call = await this.current();
    if (!call || call.callId !== callId || !participant(call, viewerUserId)) return notFoundResponse();
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const stored = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    return result({
      ok: true,
      signals: stored.filter((signal) => signal.sequence > cursor && signal.senderUserId !== viewerUserId)
    });
  }

  private async current(): Promise<CallRoomRecord | null> {
    const call = await this.state.storage.get<CallRoomRecord>(CALL_KEY);
    if (!call || !isStale(call, Date.now())) return call ?? null;
    if (!isActive(call)) return call;
    const expired = endRecord(call, "ended", "system-timeout");
    await Promise.all([
      this.state.storage.put(CALL_KEY, expired),
      this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
    ]);
    await this.clearActivePointers(expired);
    await this.realtime.publishToUsers([expired.callerUserId, expired.calleeUserId], {
      type: "call.ended",
      callId: expired.callId,
      conversationId: expired.conversationId,
      endedAt: expired.endedAt,
      endedByUserId: expired.endedByUserId,
      reason: "timeout"
    });
    return expired;
  }

  private async syncActivePointers(call: CallRoomRecord): Promise<void> {
    const expiresAt = activeExpiresAt(call);
    await Promise.all([
      this.realtime.setActiveCall(call.callerUserId, publicCall(call, call.callerUserId), expiresAt),
      this.realtime.setActiveCall(call.calleeUserId, publicCall(call, call.calleeUserId), expiresAt)
    ]);
  }

  private async clearActivePointers(call: CallRoomRecord): Promise<void> {
    await Promise.all([
      this.realtime.clearActiveCall(call.callerUserId, call.callId),
      this.realtime.clearActiveCall(call.calleeUserId, call.callId)
    ]);
  }
}

function publicCall(call: CallRoomRecord, viewerUserId: string) {
  return {
    ...call,
    direction: call.callerUserId === viewerUserId ? "outgoing" : "incoming",
    peer: call.callerUserId === viewerUserId ? call.callee : call.caller
  };
}

function activeExpiresAt(call: CallRoomRecord): number {
  return call.updatedAt + (call.status === "ringing" ? RINGING_TTL_MS : ACCEPTED_TTL_MS);
}

function endRecord(call: CallRoomRecord, status: "declined" | "ended", actorUserId: string): CallRoomRecord {
  const now = Date.now();
  return { ...call, status, updatedAt: now, endedAt: now, endedByUserId: actorUserId };
}
function isActive(call: CallRoomRecord) { return call.status === "ringing" || call.status === "accepted"; }
function isStale(call: CallRoomRecord, now: number) {
  if (call.status === "ringing") return now - call.updatedAt > RINGING_TTL_MS;
  if (call.status === "accepted") return now - call.updatedAt > ACCEPTED_TTL_MS;
  return false;
}
function participant(call: CallRoomRecord, userId: string) { return call.callerUserId === userId || call.calleeUserId === userId; }
function asCall(value: unknown): CallRoomRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const caller = asPeer(raw.caller);
  const callee = asPeer(raw.callee);
  const callId = stringValue(raw.callId);
  const conversationId = stringValue(raw.conversationId);
  const callerUserId = stringValue(raw.callerUserId);
  const calleeUserId = stringValue(raw.calleeUserId);
  const createdAt = Number(raw.createdAt);
  if (!caller || !callee || !callId || !conversationId || !callerUserId || !calleeUserId || !Number.isFinite(createdAt)) return null;
  return {
    callId,
    conversationId,
    callerUserId,
    calleeUserId,
    caller,
    callee,
    status: "ringing",
    createdAt,
    updatedAt: createdAt,
    answeredAt: null,
    endedAt: null,
    endedByUserId: null
  };
}
function asPeer(value: unknown): CallPeerSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const userId = stringValue(raw.userId);
  const username = stringValue(raw.username);
  const displayName = stringValue(raw.displayName);
  return userId && username && displayName ? { userId, username, displayName } : null;
}
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
async function readObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function invalid(code: string, message: string) { return result({ ok: false, error: { code, message } }, 400); }
function forbidden(code: string, message: string) { return result({ ok: false, error: { code, message } }, 403); }
function conflictResponse(code: string, message: string) { return result({ ok: false, error: { code, message } }, 409); }
function notFoundResponse() { return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404); }
function result(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
