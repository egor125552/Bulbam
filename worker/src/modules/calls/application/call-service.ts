import { ApiError, badRequest, conflict, forbidden, notFound } from "../../../core/errors";
import type { DurableObjectNamespace, Env } from "../../../platform/cloudflare";
import type { Conversation, DirectConversation, GroupConversation } from "../../messaging/domain/models";
import type { MessagingRepository } from "../../messaging/ports/messaging-repository";
import type { DirectoryUser, UserDirectory } from "../../messaging/ports/user-directory";
import type { IncomingCallNotificationPublisher } from "../../notifications/application/push-notification-service";
import { DurableObjectRealtime } from "../../realtime/public";
import type { CallRoomSignal } from "../infrastructure/call-room";
import { makeIceServers } from "../infrastructure/webrtc-config";

export interface CallActor { userId: string; sessionId?: string; }

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

  async active(actor: CallActor) {
    return await this.realtime.getActiveCall(actor.userId);
  }

  async activeForConversation(actor: CallActor, rawConversationId: string) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    await this.requireAnyConversation(conversationId, actor.userId);
    const payload = await this.roomRequest(
      conversationId,
      `/active?viewerUserId=${encodeURIComponent(actor.userId)}`
    );
    return payload.call ?? null;
  }

  async start(actor: CallActor, rawConversationId: string, options?: { invitedUserIds?: unknown }) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const conversation = await this.requireAnyConversation(conversationId, actor.userId);
    if (isGroupConversation(conversation)) {
      return this.startGroupCall(actor, conversation, options?.invitedUserIds);
    }
    return this.startDirectCall(actor, conversation);
  }

  private async startDirectCall(actor: CallActor, conversation: DirectConversation) {
    const conversationId = conversation.conversationId;
    const calleeUserId = otherParticipant(conversation, actor.userId);
    const caller = await this.users.findUser(actor.userId) ?? deletedUser(actor.userId);
    const callee = await this.users.findUser(calleeUserId) ?? deletedUser(calleeUserId);
    const now = Date.now();
    const call = {
      kind: "direct",
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
      endedByUserId: null,
      callerSessionId: actor.sessionId ?? null,
      calleeSessionId: null
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
        conversationId,
        sequence: 1,
        expiresAt: now + RINGING_SLOT_MS
      }).catch((error) => console.warn("[CallPush] notification failed", error));
      if (this.defer) this.defer(task);
      else await task;
    }

    return withPeer(payload.call, actor.userId);
  }

  private async startGroupCall(
    actor: CallActor,
    conversation: GroupConversation,
    rawInvitedUserIds?: unknown
  ) {
    const conversationId = conversation.conversationId;
    if (this.realtime.available()) {
      const existingActive = await this.realtime.getActiveCall(actor.userId);
      if (existingActive && existingActive.conversationId !== conversationId) {
        conflict("call_busy", "Вы уже участвуете в другом активном звонке.");
      }
    }
    const [caller, members] = await Promise.all([
      this.users.findUser(actor.userId).then((user) => user ?? deletedUser(actor.userId)),
      this.messaging.listGroupMembers(conversationId)
    ]);
    const memberUserIds = members.map((member) => member.userId);
    const memberSet = new Set(memberUserIds);
    let invitedUserIds: string[];
    if (rawInvitedUserIds !== undefined) {
      if (!Array.isArray(rawInvitedUserIds) || rawInvitedUserIds.length === 0) {
        badRequest("invalid_call_invitees", "Выберите хотя бы одного участника группы для звонка.");
      }
      const unique = new Set<string>();
      for (const item of rawInvitedUserIds) {
        if (typeof item !== "string") {
          badRequest("invalid_call_invitees", "Некорректный участник в списке приглашения.");
        }
        const candidateId = validateUuid(item, "invitedUserId");
        if (!memberSet.has(candidateId)) {
          badRequest("invalid_call_invitees", "Можно приглашать в звонок только участников этой группы.");
        }
        if (candidateId !== actor.userId) unique.add(candidateId);
      }
      if (unique.size === 0) {
        badRequest("invalid_call_invitees", "Выберите хотя бы одного участника группы для звонка.");
      }
      invitedUserIds = [...unique];
    } else {
      invitedUserIds = memberUserIds.filter((userId) => userId !== actor.userId);
    }
    const callId = crypto.randomUUID();
    const payload = await this.roomRequest(conversationId, "/start-group", {
      method: "POST",
      body: JSON.stringify({
        callId,
        conversationId,
        groupTitle: conversation.title,
        avatarIcon: conversation.avatarIcon,
        actor: caller,
        actorSessionId: actor.sessionId ?? null,
        memberUserIds,
        invitedUserIds
      })
    });

    if (this.notifications && !payload.joinedExisting) {
      const now = Date.now();
      const tasks = invitedUserIds.map((recipientUserId) =>
        this.notifications!.notifyIncomingCall({
          recipientUserId,
          callerDisplayName: `${caller.displayName} (${conversation.title})`,
          callId: payload.call?.callId ?? callId,
          conversationId,
          sequence: 1,
          expiresAt: now + RINGING_SLOT_MS
        }).catch((error) => console.warn("[CallPush] group notification failed", error))
      );
      const batch = Promise.all(tasks);
      if (this.defer) this.defer(batch);
      else await batch;
    }

    return payload.call;
  }

  async join(actor: CallActor, rawConversationId: string, rawCallId: string) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    const conversation = await this.requireAnyConversation(conversationId, actor.userId);
    if (!isGroupConversation(conversation)) {
      return this.transition(actor, conversationId, callId, "answer");
    }
    if (this.realtime.available()) {
      const existingActive = await this.realtime.getActiveCall(actor.userId);
      if (existingActive && existingActive.callId !== callId) {
        conflict("call_busy", "Вы уже участвуете в другом активном звонке.");
      }
    }
    const [profile, members] = await Promise.all([
      this.users.findUser(actor.userId).then((user) => user ?? deletedUser(actor.userId)),
      this.messaging.listGroupMembers(conversationId)
    ]);
    const payload = await this.roomRequest(conversationId, "/join", {
      method: "POST",
      body: JSON.stringify({
        callId,
        actor: profile,
        actorSessionId: actor.sessionId ?? null,
        memberUserIds: members.map((member) => member.userId)
      })
    });
    return payload.call;
  }

  async leave(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    options: { endForAll?: boolean } = {}
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    const conversation = await this.requireAnyConversation(conversationId, actor.userId);
    if (!isGroupConversation(conversation)) {
      return this.transition(actor, conversationId, callId, "end");
    }
    const members = await this.messaging.listGroupMembers(conversationId);
    const payload = await this.roomRequest(conversationId, "/leave", {
      method: "POST",
      body: JSON.stringify({
        callId,
        actorUserId: actor.userId,
        endForAll: Boolean(options.endForAll),
        canEndForAll: conversation.ownerUserId === actor.userId,
        memberUserIds: members.map((member) => member.userId)
      })
    });
    return payload.call;
  }

  async setMute(actor: CallActor, rawConversationId: string, rawCallId: string, muted: boolean) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireAnyConversation(conversationId, actor.userId);
    const payload = await this.roomRequest(conversationId, "/mute", {
      method: "POST",
      body: JSON.stringify({
        callId,
        actorUserId: actor.userId,
        muted: Boolean(muted)
      })
    });
    return payload.call;
  }

  async get(actor: CallActor, rawConversationId: string, rawCallId: string) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireAnyConversation(conversationId, actor.userId);
    const payload = await this.roomRequest(
      conversationId,
      `/call?callId=${encodeURIComponent(callId)}&viewerUserId=${encodeURIComponent(actor.userId)}`
    );
    return payload.call;
  }

  async answer(actor: CallActor, rawConversationId: string, rawCallId: string) {
    const result = await this.answerWithSignals(actor, rawConversationId, rawCallId);
    return result.call;
  }

  async answerWithSignals(actor: CallActor, rawConversationId: string, rawCallId: string): Promise<{
    call: any;
    signals?: CallRoomSignal[];
  }> {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    const conversation = await this.requireAnyConversation(conversationId, actor.userId);
    if (isGroupConversation(conversation)) {
      return { call: await this.join(actor, conversationId, callId) };
    }
    const payload = await this.roomRequest(conversationId, "/transition", {
      method: "POST",
      body: JSON.stringify({ callId, actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, action: "answer" })
    });
    return {
      call: payload.call,
      signals: Array.isArray(payload.signals) ? payload.signals : []
    };
  }

  async decline(actor: CallActor, rawConversationId: string, rawCallId: string) {
    return this.transition(actor, rawConversationId, rawCallId, "decline");
  }

  async end(actor: CallActor, rawConversationId: string, rawCallId: string, options: { endForAll?: boolean } = {}) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    const conversation = await this.requireAnyConversation(conversationId, actor.userId);
    if (isGroupConversation(conversation)) {
      return this.leave(actor, conversationId, callId, options);
    }
    return this.transition(actor, conversationId, callId, "end");
  }

  async signal(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    body: Record<string, unknown>
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireAnyConversation(conversationId, actor.userId);
    const { kind, payload, targetUserId } = validateSignal(body);
    const response = await this.roomRequest(conversationId, "/signal", {
      method: "POST",
      body: JSON.stringify({
        callId,
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId ?? null,
        targetUserId: targetUserId ?? "",
        kind,
        payload
      })
    });
    return response.signal;
  }

  async signalBatch(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    rawSignals: unknown[]
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    if (!Array.isArray(rawSignals) || rawSignals.length === 0 || rawSignals.length > 32) {
      badRequest("invalid_call_signal", "Некорректный пакет WebRTC-сигналов.");
    }
    await this.requireAnyConversation(conversationId, actor.userId);
    const validated = rawSignals.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        badRequest("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
      }
      return validateSignal(item as Record<string, unknown>);
    });
    const response = await this.roomRequest(conversationId, "/signals-batch", {
      method: "POST",
      body: JSON.stringify({
        callId,
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId ?? null,
        signals: validated
      })
    });
    return Array.isArray(response.signals) ? response.signals : [];
  }

  async signals(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    rawAfter: string | null
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireAnyConversation(conversationId, actor.userId);
    const after = validateSequence(rawAfter);
    const payload = await this.roomRequest(
      conversationId,
      `/signals?callId=${encodeURIComponent(callId)}&viewerUserId=${encodeURIComponent(actor.userId)}&after=${after}`
    );
    return Array.isArray(payload.signals) ? payload.signals : [];
  }

  async handoff(actor: CallActor, rawConversationId: string, rawCallId: string) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    if (!actor.sessionId) forbidden("handoff_requires_session", "Для переноса нужен действующий вход.");
    await this.requireAnyConversation(conversationId, actor.userId);
    const response = await this.roomRequest(conversationId, "/handoff", {
      method: "POST",
      body: JSON.stringify({ callId, actorUserId: actor.userId, actorSessionId: actor.sessionId })
    });
    return response.call;
  }

  private async transition(
    actor: CallActor,
    rawConversationId: string,
    rawCallId: string,
    action: "answer" | "decline" | "end"
  ) {
    const conversationId = validateUuid(rawConversationId, "conversationId");
    const callId = validateUuid(rawCallId, "callId");
    await this.requireAnyConversation(conversationId, actor.userId);
    const payload = await this.roomRequest(conversationId, "/transition", {
      method: "POST",
      body: JSON.stringify({ callId, actorUserId: actor.userId, actorSessionId: actor.sessionId ?? null, action })
    });
    return payload.call;
  }

  private async requireAnyConversation(conversationId: string, userId: string): Promise<Conversation> {
    const conversation = await this.messaging.findAnyConversationForUser(conversationId, userId);
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

function isGroupConversation(conversation: Conversation): conversation is GroupConversation {
  return "kind" in conversation && conversation.kind === "group";
}

function withPeer(call: any, viewerUserId: string) {
  if (!call || typeof call !== "object") return call;
  if (call.kind === "group") return call;
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
  targetUserId?: string;
} {
  const kind = body.kind;
  if (kind !== "offer" && kind !== "answer" && kind !== "ice" && kind !== "resume") {
    badRequest("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
  }
  let targetUserId: string | undefined;
  if (body.targetUserId !== undefined && body.targetUserId !== null && body.targetUserId !== "") {
    if (typeof body.targetUserId !== "string") {
      badRequest("invalid_signal_target", "Некорректный получатель сигнала в групповом звонке.");
    }
    targetUserId = validateUuid(body.targetUserId, "targetUserId");
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
    return { kind, payload, targetUserId };
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
  return { kind, payload, targetUserId };
}
