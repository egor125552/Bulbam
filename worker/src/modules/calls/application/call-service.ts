import { ApiError, badRequest, conflict, notFound } from "../../../core/errors";
import type { DurableObjectNamespace, Env } from "../../../platform/cloudflare";
import type { DirectConversation } from "../../messaging/domain/models";
import type { MessagingRepository } from "../../messaging/ports/messaging-repository";
import type { DirectoryUser, UserDirectory } from "../../messaging/ports/user-directory";
import type { IncomingCallNotificationPublisher } from "../../notifications/application/push-notification-service";
import { DurableObjectRealtime } from "../../realtime/public";
import type { CallRoomSignal } from "../infrastructure/call-room";
import { makeIceServers } from "../infrastructure/webrtc-config";

export interface CallActor { userId: string; }

const RINGING_SLOT_MS = 2 * 60 * 1000;

export class CallService {
  private readonly realtime: DurableObjectRealtime;

  constructor(
    private readonly rooms: DurableObjectNamespace,
    private readonly messaging: MessagingRepository,
    private readonly users: UserDirectory,
    private readonly env: Env,
    private readonly notifications?: IncomingCallNotificationPublisher,
    private readonly defer?: (promise: Promise<unknown>) => void
  ) {
    this.realtime = new DurableObjectRealtime(env.REALTIME);
  }

  async iceServers(actor: CallActor) {
    return makeIceServers(this.env, actor.userId);
  }

  async start(actor: CallActor, rawConversationId: string) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const conversation = await this.requireConversation(conversationId, actor.userId);
    const calleeUserId = otherParticipant(conversation, actor.userId);
    const caller = await this.users.findUser(actor.userId) ?? deletedUser(actor.userId);
    const callee = await this.users.findUser(calleeUserId) ?? deletedUser(calleeUserId);
    const now = Date.now();
    const call = {
      callId: crypto.randomUUID(),
      conversationId,
      callerUserId: actor.userId,
      calleeUserId,
      caller,
      callee,
      status: "ringing",
      createdAt: now,
      updatedAt: now,
      answeredAt: null,
      endedAt: null,
      endedByUserId: null
    };

    let claimedUsers: string[] = [];
    if (this.realtime.available()) {
      const expiresAt = now + RINGING_SLOT_MS;
      const callerClaimed = await this.realtime.claimActiveCall(
        actor.userId,
        withPeer(call, actor.userId),
        expiresAt
      );
      if (!callerClaimed) {
        conflict("call_busy", "Вы уже участвуете в другом активном звонке.");
      }
      claimedUsers = [actor.userId];

      const calleeClaimed = await this.realtime.claimActiveCall(
        calleeUserId,
        withPeer(call, calleeUserId),
        expiresAt
      );
      if (!calleeClaimed) {
        await this.realtime.clearActiveCall(actor.userId, call.callId);
        conflict("call_busy", "Собеседник уже участвует в другом активном звонке.");
      }
      claimedUsers.push(calleeUserId);
    }

    let payload: Record<string, any>;
    try {
      payload = await this.roomRequest(conversationId, "/start", {
        method: "POST",
        body: JSON.stringify({ call })
      });
    } catch (error) {
      await Promise.all(
        claimedUsers.map((userId) => this.realtime.clearActiveCall(userId, call.callId))
      );
      throw error;
    }

    if (this.notifications) {
      const task = this.notifications.notifyIncomingCall({
        recipientUserId: calleeUserId,
        callerDisplayName: caller.displayName,
        callId: call.callId,
        conversationId
      }).catch((error) => console.warn("[CallPush] notification failed", error));
      if (this.defer) this.defer(task);
      else await task;
    }

    return withPeer(payload.call, actor.userId);
  }

  async get(actor: CallActor, rawConversationId: string, rawCallId: string) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireConversation(conversationId, actor.userId);
    const payload = await this.roomRequest(
      conversationId,
      `/call?callId=${encodeURIComponent(callId)}&viewerUserId=${encodeURIComponent(actor.userId)}`
    );
    return payload.call;
  }

  async answer(actor: CallActor, rawConversationId: string, rawCallId: string) {
    return this.transition(actor, rawConversationId, rawCallId, "answer");
  }

  async decline(actor: CallActor, rawConversationId: string, rawCallId: string) {
    return this.transition(actor, rawConversationId, rawCallId, "decline");
  }

  async end(actor: CallActor, rawConversationId: string, rawCallId: string) {
    return this.transition(actor, rawConversationId, rawCallId, "end");
  }

  async signal(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireConversation(conversationId, actor.userId);
    const { kind, payload } = validateSignal(body);
    const response = await this.roomRequest(conversationId, "/signal", {
      method: "POST",
      body: JSON.stringify({
        callId,
        actorUserId: actor.userId,
        kind,
        payload
      })
    });
    return response.signal;
  }

  async signals(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    rawAfter: string | null
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireConversation(conversationId, actor.userId);
    const after = validateSequence(rawAfter);
    const payload = await this.roomRequest(
      conversationId,
      `/signals?callId=${encodeURIComponent(callId)}&viewerUserId=${encodeURIComponent(actor.userId)}&after=${after}`
    );
    return Array.isArray(payload.signals) ? payload.signals : [];
  }

  private async transition(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    action: "answer" | "decline" | "end"
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireConversation(conversationId, actor.userId);
    const payload = await this.roomRequest(conversationId, "/transition", {
      method: "POST",
      body: JSON.stringify({ callId, actorUserId: actor.userId, action })
    });
    return payload.call;
  }

  private async requireConversation(conversationId: string, userId: string): Promise<DirectConversation> {
    const conversation = await this.messaging.findConversationForUser(conversationId, userId);
    if (!conversation) notFound("chat_not_found", "Диалог не найден.");
    return conversation;
  }

  private async roomRequest(
    conversationId: string,
    path: string,
    init?: RequestInit
  ): Promise<Record<string, any>> {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    const response = await this.rooms.getByName(conversationId).fetch(
      new Request(`https://call-room.internal${path}`, {
        ...init,
        headers
      })
    );
    let payload: any = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || !payload?.ok) {
      throw new ApiError(
        response.status || 500,
        payload?.error?.code || "call_room_failure",
        payload?.error?.message || "Не удалось обработать звонок."
      );
    }
    return payload;
  }
}

function withPeer(call: any, viewerUserId: string) {
  if (!call || typeof call !== "object") return call;
  return {
    ...call,
    direction: call.callerUserId === viewerUserId ? "outgoing" : "incoming",
    peer: call.callerUserId === viewerUserId ? call.callee : call.caller
  };
}

function otherParticipant(conversation: DirectConversation, userId: string): string {
  return conversation.participantAId === userId
    ? conversation.participantBId
    : conversation.participantAId;
}

function deletedUser(userId: string): DirectoryUser {
  return { userId, username: "deleted", displayName: "Удалённый аккаунт" };
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
  kind: CallRoomSignal["kind"];
  payload: unknown;
} {
  const kind = body.kind;
  if (kind !== "offer" && kind !== "answer" && kind !== "ice" && kind !== "resume") {
    badRequest("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
  }
  const payload = body.payload;
  const encoded = JSON.stringify(payload);
  if (!encoded || encoded.length > 64 * 1024) {
    badRequest("call_signal_too_large", "WebRTC-сигнал слишком большой.");
  }

  if (kind === "resume") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      badRequest("invalid_call_resume", "Некорректный запрос восстановления звонка.");
    }
    return { kind, payload };
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
