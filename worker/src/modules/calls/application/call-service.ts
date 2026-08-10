import { badRequest, conflict, forbidden, notFound } from "../../../core/errors";
import type { MessagingRepository } from "../../messaging/ports/messaging-repository";
import type { RealtimePublisher } from "../../messaging/ports/realtime-publisher";
import type { UserDirectory } from "../../messaging/ports/user-directory";
import type { IncomingCallNotificationPublisher } from "../../notifications/application/push-notification-service";
import type {
  D1CallRepository,
  StoredCall,
  StoredCallSignal
} from "../infrastructure/d1-call-repository";

export interface CallActor {
  userId: string;
}

export class CallService {
  constructor(
    private readonly calls: D1CallRepository,
    private readonly messaging: MessagingRepository,
    private readonly users: UserDirectory,
    private readonly realtime: RealtimePublisher,
    private readonly notifications?: IncomingCallNotificationPublisher,
    private readonly defer?: (promise: Promise<unknown>) => void
  ) {}

  initialize(): Promise<void> {
    return this.calls.initialize();
  }

  iceServers() {
    return [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  }

  async start(actor: CallActor, rawConversationId: string) {
    const now = Date.now();
    await this.calls.expireStale(now);
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const conversation = await this.messaging.findConversationForUser(conversationId, actor.userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");

    const calleeUserId = conversation.participantAId === actor.userId
      ? conversation.participantBId
      : conversation.participantAId;
    if (await this.calls.hasActiveCall([actor.userId, calleeUserId])) {
      conflict("call_busy", "У одного из участников уже есть активный звонок.");
    }

    const call: StoredCall = {
      callId: crypto.randomUUID(),
      conversationId,
      callerUserId: actor.userId,
      calleeUserId,
      status: "ringing",
      createdAt: now,
      answeredAt: null,
      endedAt: null,
      endedByUserId: null
    };
    await this.calls.insert(call);
    const view = await this.view(call, actor.userId);
    const calleeView = await this.view(call, calleeUserId);

    await this.realtime.publishToUsers([calleeUserId], {
      type: "call.ringing",
      call: calleeView
    });

    if (this.notifications) {
      const caller = await this.users.findUser(actor.userId);
      const task = this.notifications.notifyIncomingCall({
        recipientUserId: calleeUserId,
        callerDisplayName: caller?.displayName ?? "Бульбам",
        callId: call.callId,
        conversationId
      }).catch((error) => console.warn("[CallPush] notification failed", error));
      if (this.defer) this.defer(task);
      else await task;
    }

    return view;
  }

  async get(actor: CallActor, rawCallId: string) {
    const call = await this.requireParticipant(actor, rawCallId);
    return this.view(call, actor.userId);
  }

  async answer(actor: CallActor, rawCallId: string) {
    const call = await this.requireParticipant(actor, rawCallId);
    if (call.calleeUserId !== actor.userId) {
      forbidden("call_answer_forbidden", "Ответить на этот звонок может только получатель.");
    }
    if (call.status !== "ringing") {
      conflict("call_not_ringing", "Этот звонок уже не ожидает ответа.");
    }
    const updated = await this.calls.transition(call.callId, ["ringing"], "accepted", actor.userId, Date.now());
    if (!updated) conflict("call_state_changed", "Состояние звонка уже изменилось.");
    await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
      type: "call.answered",
      callId: updated.callId,
      answeredAt: updated.answeredAt
    });
    return this.view(updated, actor.userId);
  }

  async decline(actor: CallActor, rawCallId: string) {
    const call = await this.requireParticipant(actor, rawCallId);
    if (call.calleeUserId !== actor.userId) {
      forbidden("call_decline_forbidden", "Отклонить этот звонок может только получатель.");
    }
    if (call.status !== "ringing") {
      conflict("call_not_ringing", "Этот звонок уже не ожидает ответа.");
    }
    const updated = await this.calls.transition(call.callId, ["ringing"], "declined", actor.userId, Date.now());
    if (!updated) conflict("call_state_changed", "Состояние звонка уже изменилось.");
    await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
      type: "call.declined",
      callId: updated.callId,
      endedAt: updated.endedAt
    });
    await this.calls.deleteSignals(updated.callId);
    return this.view(updated, actor.userId);
  }

  async end(actor: CallActor, rawCallId: string) {
    const call = await this.requireParticipant(actor, rawCallId);
    if (call.status === "declined" || call.status === "ended") return this.view(call, actor.userId);
    const updated = await this.calls.transition(
      call.callId,
      ["ringing", "accepted"],
      "ended",
      actor.userId,
      Date.now()
    );
    if (!updated) {
      const latest = await this.calls.find(call.callId);
      if (!latest) notFound("call_not_found", "Звонок не найден.");
      return this.view(latest, actor.userId);
    }
    await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
      type: "call.ended",
      callId: updated.callId,
      endedAt: updated.endedAt,
      endedByUserId: updated.endedByUserId
    });
    await this.calls.deleteSignals(updated.callId);
    return this.view(updated, actor.userId);
  }

  async signal(actor: CallActor, rawCallId: string, body: Record<string, unknown>) {
    const call = await this.requireParticipant(actor, rawCallId);
    if (call.status !== "accepted") {
      conflict("call_not_accepted", "Сигнал WebRTC можно передавать только после ответа на звонок.");
    }
    const { kind, payload } = validateSignal(body);
    if (kind === "offer" && actor.userId !== call.callerUserId) {
      forbidden("call_offer_forbidden", "WebRTC offer создаёт инициатор звонка.");
    }
    if (kind === "answer" && actor.userId !== call.calleeUserId) {
      forbidden("call_answer_signal_forbidden", "WebRTC answer создаёт получатель звонка.");
    }

    const signal = await this.calls.insertSignal(call.callId, actor.userId, kind, payload, Date.now());
    const recipientUserId = actor.userId === call.callerUserId ? call.calleeUserId : call.callerUserId;
    await this.realtime.publishToUsers([recipientUserId], {
      type: "call.signal",
      callId: call.callId,
      signal
    });
    return signal;
  }

  async signals(actor: CallActor, rawCallId: string, rawAfter: string | null) {
    const call = await this.requireParticipant(actor, rawCallId);
    const after = validateSequence(rawAfter);
    const signals = await this.calls.listSignals(call.callId, after, 100);
    return signals.filter((signal) => signal.senderUserId !== actor.userId);
  }

  private async requireParticipant(actor: CallActor, rawCallId: string): Promise<StoredCall> {
    const callId = validateUuid(rawCallId, "callId");
    await this.calls.expireStale(Date.now());
    const call = await this.calls.find(callId);
    if (!call) notFound("call_not_found", "Звонок не найден.");
    if (call.callerUserId !== actor.userId && call.calleeUserId !== actor.userId) {
      notFound("call_not_found", "Звонок не найден.");
    }
    return call;
  }

  private async view(call: StoredCall, viewerUserId: string) {
    const peerUserId = call.callerUserId === viewerUserId ? call.calleeUserId : call.callerUserId;
    const peer = await this.users.findUser(peerUserId);
    return {
      ...call,
      direction: call.callerUserId === viewerUserId ? "outgoing" : "incoming",
      peer: peer ?? { userId: peerUserId, username: "deleted", displayName: "Удалённый аккаунт" }
    };
  }
}

function validateUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    badRequest("invalid_call_identifier", `Некорректный ${field}.`);
  }
  return value;
}

function validateSequence(value: string | null): number {
  if (value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    badRequest("invalid_signal_sequence", "Некорректная позиция сигналов звонка.");
  }
  return parsed;
}

function validateSignal(body: Record<string, unknown>): {
  kind: StoredCallSignal["kind"];
  payload: unknown;
} {
  const kind = body.kind;
  if (kind !== "offer" && kind !== "answer" && kind !== "ice") {
    badRequest("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
  }
  const payload = body.payload;
  const encoded = JSON.stringify(payload);
  if (!encoded || encoded.length > 64 * 1024) {
    badRequest("call_signal_too_large", "WebRTC-сигнал слишком большой.");
  }

  if (kind === "offer" || kind === "answer") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      badRequest("invalid_session_description", "Некорректное описание WebRTC-сессии.");
    }
    const description = payload as Record<string, unknown>;
    if (description.type !== kind || typeof description.sdp !== "string" || description.sdp.length > 60 * 1024) {
      badRequest("invalid_session_description", "Некорректное описание WebRTC-сессии.");
    }
  } else {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      badRequest("invalid_ice_candidate", "Некорректный ICE-кандидат.");
    }
    const candidate = payload as Record<string, unknown>;
    if (typeof candidate.candidate !== "string" || candidate.candidate.length > 4096) {
      badRequest("invalid_ice_candidate", "Некорректный ICE-кандидат.");
    }
  }

  return { kind, payload };
}
