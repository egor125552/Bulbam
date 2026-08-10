import type { DurableObjectState, Env } from "../../../platform/cloudflare";
import { DurableObjectRealtime } from "../../realtime/public";

export type CallStatus = "ringing" | "accepted" | "declined" | "ended";

export interface CallRoomRecord {
  callId: string;
  conversationId: string;
  callerUserId: string;
  calleeUserId: string;
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
  kind: "offer" | "answer" | "ice";
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

  constructor(
    private readonly state: DurableObjectState,
    env: Env
  ) {
    this.realtime = new DurableObjectRealtime(env.REALTIME);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") {
        return this.start(await readObject(request));
      }
      if (request.method === "GET" && url.pathname === "/call") {
        return this.getCall(
          url.searchParams.get("callId") ?? "",
          url.searchParams.get("viewerUserId") ?? ""
        );
      }
      if (request.method === "POST" && url.pathname === "/transition") {
        return this.transition(await readObject(request));
      }
      if (request.method === "POST" && url.pathname === "/signal") {
        return this.signal(await readObject(request));
      }
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
      return result(
        { ok: false, error: { code: "call_busy", message: "В этом диалоге уже есть активный звонок." } },
        409
      );
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
    return result({ ok: true, call });
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
      if (actorUserId !== call.calleeUserId) {
        return result({ ok: false, error: { code: "call_answer_forbidden", message: "Ответить может только получатель звонка." } }, 403);
      }
      if (call.status !== "ringing") {
        return result({ ok: false, error: { code: "call_not_ringing", message: "Звонок уже не ожидает ответа." } }, 409);
      }
      const now = Date.now();
      const updated: CallRoomRecord = {
        ...call,
        status: "accepted",
        answeredAt: now,
        updatedAt: now
      };
      await this.state.storage.put(CALL_KEY, updated);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.answered",
        callId: updated.callId,
        conversationId: updated.conversationId,
        answeredAt: updated.answeredAt
      });
      return result({ ok: true, call: updated });
    }

    if (action === "decline") {
      if (actorUserId !== call.calleeUserId) {
        return result({ ok: false, error: { code: "call_decline_forbidden", message: "Отклонить может только получатель звонка." } }, 403);
      }
      if (call.status !== "ringing") {
        return result({ ok: false, error: { code: "call_not_ringing", message: "Звонок уже не ожидает ответа." } }, 409);
      }
      const updated = endRecord(call, "declined", actorUserId);
      await Promise.all([
        this.state.storage.put(CALL_KEY, updated),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.declined",
        callId: updated.callId,
        conversationId: updated.conversationId,
        endedAt: updated.endedAt
      });
      return result({ ok: true, call: updated });
    }

    if (action === "end") {
      if (!isActive(call)) return result({ ok: true, call });
      const updated = endRecord(call, "ended", actorUserId);
      await Promise.all([
        this.state.storage.put(CALL_KEY, updated),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.ended",
        callId: updated.callId,
        conversationId: updated.conversationId,
        endedAt: updated.endedAt,
        endedByUserId: updated.endedByUserId
      });
      return result({ ok: true, call: updated });
    }

    return invalid("invalid_call_action", "Неизвестное действие звонка.");
  }

  private async signal(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const kind = stringValue(body.kind);
    const call = await this.current();
    if (!call || call.callId !== callId || !participant(call, actorUserId)) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }
    if (call.status !== "accepted") {
      return result({ ok: false, error: { code: "call_not_accepted", message: "Сигналы разрешены только после ответа." } }, 409);
    }
    if (kind !== "offer" && kind !== "answer" && kind !== "ice") {
      return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
    }
    if (kind === "offer" && actorUserId !== call.callerUserId) {
      return result({ ok: false, error: { code: "call_offer_forbidden", message: "Offer создаёт инициатор звонка." } }, 403);
    }
    if (kind === "answer" && actorUserId !== call.calleeUserId) {
      return result({ ok: false, error: { code: "call_answer_signal_forbidden", message: "Answer создаёт получатель звонка." } }, 403);
    }

    const currentSignals = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    const nextSequence = (currentSignals.at(-1)?.sequence ?? 0) + 1;
    const signal: CallRoomSignal = {
      sequence: nextSequence,
      callId,
      senderUserId: actorUserId,
      kind,
      payload: body.payload,
      createdAt: Date.now()
    };
    const nextSignals = [...currentSignals, signal].slice(-MAX_SIGNALS);
    await Promise.all([
      this.state.storage.put(SIGNALS_KEY, nextSignals),
      this.state.storage.put(CALL_KEY, { ...call, updatedAt: Date.now() })
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

  private async signals(
    callId: string,
    viewerUserId: string,
    after: number
  ): Promise<Response> {
    const call = await this.current();
    if (!call || call.callId !== callId || !participant(call, viewerUserId)) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const stored = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    const signals = stored.filter(
      (signal) => signal.sequence > cursor && signal.senderUserId !== viewerUserId
    );
    return result({ ok: true, signals });
  }

  private async current(): Promise<CallRoomRecord | null> {
    const call = await this.state.storage.get<CallRoomRecord>(CALL_KEY);
    if (!call) return null;
    if (!isStale(call, Date.now())) return call;

    if (isActive(call)) {
      const expired = endRecord(call, "ended", "system-timeout");
      await Promise.all([
        this.state.storage.put(CALL_KEY, expired),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
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
    return call;
  }
}

function publicCall(call: CallRoomRecord, viewerUserId: string) {
  return {
    ...call,
    direction: call.callerUserId === viewerUserId ? "outgoing" : "incoming"
  };
}

function endRecord(
  call: CallRoomRecord,
  status: "declined" | "ended",
  actorUserId: string
): CallRoomRecord {
  const now = Date.now();
  return {
    ...call,
    status,
    updatedAt: now,
    endedAt: now,
    endedByUserId: actorUserId
  };
}

function isActive(call: CallRoomRecord): boolean {
  return call.status === "ringing" || call.status === "accepted";
}

function isStale(call: CallRoomRecord, now: number): boolean {
  if (call.status === "ringing") return now - call.updatedAt > RINGING_TTL_MS;
  if (call.status === "accepted") return now - call.updatedAt > ACCEPTED_TTL_MS;
  return false;
}

function participant(call: CallRoomRecord, userId: string): boolean {
  return call.callerUserId === userId || call.calleeUserId === userId;
}

function asCall(value: unknown): CallRoomRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const callId = stringValue(raw.callId);
  const conversationId = stringValue(raw.conversationId);
  const callerUserId = stringValue(raw.callerUserId);
  const calleeUserId = stringValue(raw.calleeUserId);
  const createdAt = Number(raw.createdAt);
  if (!callId || !conversationId || !callerUserId || !calleeUserId || !Number.isFinite(createdAt)) return null;
  return {
    callId,
    conversationId,
    callerUserId,
    calleeUserId,
    status: "ringing",
    createdAt,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : createdAt,
    answeredAt: null,
    endedAt: null,
    endedByUserId: null
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function invalid(code: string, message: string): Response {
  return result({ ok: false, error: { code, message } }, 400);
}

function result(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
