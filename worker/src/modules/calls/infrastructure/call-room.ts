import type { DurableObjectState, Env } from "../../../platform/cloudflare";
import {
  createCallNotificationPublisher,
  type IncomingCallNotificationPublisher
} from "../../notifications/public";
import { DurableObjectRealtime } from "../../realtime/public";

export type CallKind = "direct" | "group";
export type CallStatus = "ringing" | "accepted" | "declined" | "ended";
export interface CallPeerSnapshot { userId: string; username: string; displayName: string; }
export interface CallParticipantRecord {
  userId: string;
  username: string;
  displayName: string;
  sessionId: string | null;
  joinedAt: number;
  muted: boolean;
}
export interface CallRoomRecord {
  kind?: CallKind;
  callId: string;
  conversationId: string;
  callerUserId: string;
  calleeUserId: string;
  caller: CallPeerSnapshot;
  callee: CallPeerSnapshot;
  groupTitle?: string;
  avatarIcon?: string;
  memberUserIds?: string[];
  invitedUserIds?: string[];
  participants?: CallParticipantRecord[];
  status: CallStatus;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endedByUserId: string | null;
  callerSessionId?: string | null;
  calleeSessionId?: string | null;
}
export interface CallRoomSignal {
  sequence: number;
  callId: string;
  senderUserId: string;
  targetUserId?: string;
  kind: "offer" | "answer" | "ice" | "resume";
  payload: unknown;
  createdAt: number;
}
interface RingPushState {
  callId: string;
  pulsesSent: number;
  startedAt: number;
}

const CALL_KEY = "activeCall";
const SIGNALS_KEY = "signals";
const RING_PUSH_KEY = "ringPush";
const RINGING_TTL_MS = 2 * 60 * 1000;
const ACCEPTED_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SIGNALS = 128;
const MAX_GROUP_SIGNALS = 512;
const MAX_GROUP_PARTICIPANTS = 12;
export const RING_PUSH_INTERVAL_MS = 2_000;
export const RING_PUSH_WINDOW_MS = 30_000;
export const RING_PUSH_MAX_PULSES = 15;

export class CallRoom {
  private readonly realtime: DurableObjectRealtime;
  private readonly notifications: IncomingCallNotificationPublisher | null;
  constructor(
    private readonly state: DurableObjectState,
    env: Env,
    notificationsOverride?: IncomingCallNotificationPublisher | null
  ) {
    this.realtime = new DurableObjectRealtime(env.REALTIME);
    this.notifications = notificationsOverride !== undefined
      ? notificationsOverride
      : createCallNotificationPublisher(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/active") {
        return this.getActive(url.searchParams.get("viewerUserId") ?? "");
      }
      if (request.method === "POST" && url.pathname === "/start") return this.start(await readObject(request));
      if (request.method === "POST" && url.pathname === "/start-group") return this.startGroup(await readObject(request));
      if (request.method === "POST" && url.pathname === "/join") return this.joinGroup(await readObject(request));
      if (request.method === "POST" && url.pathname === "/leave") return this.leaveGroup(await readObject(request));
      if (request.method === "POST" && url.pathname === "/mute") return this.setMute(await readObject(request));
      if (request.method === "GET" && url.pathname === "/call") {
        return this.getCall(url.searchParams.get("callId") ?? "", url.searchParams.get("viewerUserId") ?? "");
      }
      if (request.method === "POST" && url.pathname === "/transition") return this.transition(await readObject(request));
      if (request.method === "POST" && url.pathname === "/handoff") return this.handoff(await readObject(request));
      if (request.method === "POST" && url.pathname === "/signal") return this.signal(await readObject(request));
      if (request.method === "POST" && url.pathname === "/signals-batch") return this.signalBatch(await readObject(request));
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

  async alarm(): Promise<void> {
    const call = await this.current();
    if (!call || isGroupCall(call) || call.status !== "ringing" || !this.notifications) {
      await this.stopRingPushes();
      return;
    }
    const ringState = await this.state.storage.get<RingPushState>(RING_PUSH_KEY);
    if (!ringState || ringState.callId !== call.callId) {
      await this.stopRingPushes();
      return;
    }
    const now = Date.now();
    if (now - ringState.startedAt >= RING_PUSH_WINDOW_MS || ringState.pulsesSent >= RING_PUSH_MAX_PULSES) {
      await this.stopRingPushes();
      return;
    }

    const nextSequence = ringState.pulsesSent + 1;
    await this.notifications.notifyIncomingCall({
      recipientUserId: call.calleeUserId,
      callerDisplayName: call.caller.displayName,
      callId: call.callId,
      conversationId: call.conversationId,
      sequence: nextSequence,
      expiresAt: call.createdAt + RINGING_TTL_MS
    }).catch((error) => console.warn("[CallRoom] repeat ring push failed", error));

    const nextAt = now + RING_PUSH_INTERVAL_MS;
    if (nextSequence >= RING_PUSH_MAX_PULSES || nextAt - ringState.startedAt >= RING_PUSH_WINDOW_MS) {
      await this.stopRingPushes();
      return;
    }
    await this.state.storage.put<RingPushState>(RING_PUSH_KEY, {
      ...ringState,
      pulsesSent: nextSequence
    });
    await this.state.storage.setAlarm(nextAt);
  }

  private async getActive(viewerUserId: string): Promise<Response> {
    const call = await this.current();
    if (!call || !isActive(call)) return result({ ok: true, call: null });
    if (!isGroupCall(call) && !participant(call, viewerUserId)) {
      return result({ ok: true, call: null });
    }
    return result({ ok: true, call: publicCall(call, viewerUserId) });
  }

  private async start(body: Record<string, unknown>): Promise<Response> {
    const incoming = asCall(body.call);
    if (!incoming) return invalid("invalid_call", "Некорректное состояние звонка.");
    const current = await this.current();
    if (current && isActive(current)) {
      return result({ ok: false, error: { code: "call_busy", message: "В этом диалоге уже есть активный звонок." } }, 409);
    }
    const now = Date.now();
    const call: CallRoomRecord = {
      ...incoming,
      kind: "direct",
      status: "ringing",
      updatedAt: now,
      answeredAt: null,
      endedAt: null,
      endedByUserId: null
    };
    await Promise.all([
      this.state.storage.put(CALL_KEY, call),
      this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
    ]);
    await Promise.all([
      this.startRingPushes(call, now),
      this.syncActivePointers(call),
      this.realtime.publishToUsers([call.calleeUserId], {
        type: "call.ringing",
        call: publicCall(call, call.calleeUserId)
      })
    ]);
    return result({ ok: true, call });
  }

  private async startGroup(body: Record<string, unknown>): Promise<Response> {
    const actor = asPeer(body.actor);
    const callId = stringValue(body.callId);
    const conversationId = stringValue(body.conversationId);
    const groupTitle = stringValue(body.groupTitle) || "Группа";
    const avatarIcon = stringValue(body.avatarIcon) || "👥";
    const actorSessionId = stringValue(body.actorSessionId) || null;
    const memberUserIds = Array.isArray(body.memberUserIds)
      ? [...new Set(body.memberUserIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
    if (!actor || !callId || !conversationId) {
      return invalid("invalid_call", "Некорректное состояние звонка.");
    }
    if (!memberUserIds.includes(actor.userId)) memberUserIds.push(actor.userId);
    const memberSet = new Set(memberUserIds);
    const invitedUserIds = Array.isArray(body.invitedUserIds)
      ? [...new Set(body.invitedUserIds.filter((id): id is string => typeof id === "string" && id !== actor.userId && memberSet.has(id)))]
      : memberUserIds.filter((userId) => userId !== actor.userId);

    const current = await this.current();
    if (current && isActive(current) && isGroupCall(current)) {
      // Seamless join-or-create: concurrent starters land in the same group call.
      return this.joinExistingGroup(current, actor, actorSessionId, memberUserIds, true);
    }
    if (current && isActive(current)) {
      return conflictResponse("call_busy", "В этом диалоге уже есть активный звонок.");
    }

    const now = Date.now();
    const hostParticipant: CallParticipantRecord = {
      ...actor,
      sessionId: actorSessionId,
      joinedAt: now,
      muted: false
    };
    const groupPeer: CallPeerSnapshot = {
      userId: conversationId,
      username: "group",
      displayName: groupTitle
    };
    const call: CallRoomRecord = {
      kind: "group",
      callId,
      conversationId,
      callerUserId: actor.userId,
      calleeUserId: conversationId,
      caller: actor,
      callee: groupPeer,
      groupTitle,
      avatarIcon,
      memberUserIds,
      invitedUserIds,
      participants: [hostParticipant],
      status: "accepted",
      createdAt: now,
      updatedAt: now,
      answeredAt: now,
      endedAt: null,
      endedByUserId: null,
      callerSessionId: actorSessionId,
      calleeSessionId: null
    };

    await Promise.all([
      this.state.storage.put(CALL_KEY, call),
      this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
    ]);
    await this.stopRingPushes();
    await this.syncActivePointers(call);

    if (invitedUserIds.length) {
      await Promise.all(invitedUserIds.map((userId) =>
        this.realtime.publishToUsers([userId], {
          type: "call.ringing",
          call: publicCall(call, userId)
        })
      ));
    }
    await this.publishGroupSummary(call, true);
    return result({ ok: true, call: publicCall(call, actor.userId), joinedExisting: false }, 201);
  }

  private async joinGroup(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actor = asPeer(body.actor);
    const actorSessionId = stringValue(body.actorSessionId) || null;
    const memberUserIds = Array.isArray(body.memberUserIds)
      ? body.memberUserIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (!callId || !actor) return invalid("invalid_call", "Некорректное состояние звонка.");
    const call = await this.current();
    if (!call || call.callId !== callId || !isGroupCall(call)) return notFoundResponse();
    if (!isActive(call)) return conflictResponse("call_not_accepted", "Групповой звонок уже завершён.");
    return this.joinExistingGroup(call, actor, actorSessionId, memberUserIds, false);
  }

  private async joinExistingGroup(
    call: CallRoomRecord,
    actor: CallPeerSnapshot,
    actorSessionId: string | null,
    memberUserIds: string[],
    joinedExisting: boolean
  ): Promise<Response> {
    const now = Date.now();
    const existingList = [...(call.participants ?? [])];
    const existingIndex = existingList.findIndex((entry) => entry.userId === actor.userId);
    const mergedMembers = [...new Set([...(call.memberUserIds ?? []), ...memberUserIds, actor.userId])];

    let joinedParticipant: CallParticipantRecord;
    let isNewJoin = false;
    if (existingIndex >= 0) {
      joinedParticipant = {
        ...existingList[existingIndex],
        username: actor.username,
        displayName: actor.displayName,
        sessionId: actorSessionId ?? existingList[existingIndex].sessionId
      };
      existingList[existingIndex] = joinedParticipant;
    } else {
      if (existingList.length >= MAX_GROUP_PARTICIPANTS) {
        return conflictResponse("call_room_full", `В групповом звонке уже максимум участников (${MAX_GROUP_PARTICIPANTS}).`);
      }
      isNewJoin = true;
      joinedParticipant = {
        ...actor,
        sessionId: actorSessionId,
        joinedAt: now,
        muted: false
      };
      existingList.push(joinedParticipant);
    }

    const updated: CallRoomRecord = {
      ...call,
      memberUserIds: mergedMembers,
      participants: existingList,
      updatedAt: now
    };
    await this.state.storage.put(CALL_KEY, updated);
    await this.syncActivePointers(updated);

    const participantIds = existingList.map((entry) => entry.userId);
    if (isNewJoin) {
      await Promise.all(participantIds.map((viewerId) =>
        this.realtime.publishToUsers([viewerId], {
          type: "call.participant.joined",
          callId: updated.callId,
          conversationId: updated.conversationId,
          participant: publicParticipant(joinedParticipant),
          participants: existingList.map(publicParticipant),
          call: publicCall(updated, viewerId)
        })
      ));
    }
    await this.publishGroupSummary(updated, true);
    return result({ ok: true, call: publicCall(updated, actor.userId), joinedExisting });
  }

  private async leaveGroup(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const endForAll = body.endForAll === true;
    const canEndForAll = body.canEndForAll === true;
    const memberUserIds = Array.isArray(body.memberUserIds)
      ? body.memberUserIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const call = await this.current();
    if (!call || call.callId !== callId || !isGroupCall(call)) return notFoundResponse();
    if (!isActive(call)) return result({ ok: true, call: publicCall(call, actorUserId) });

    const now = Date.now();
    const existingList = [...(call.participants ?? [])];
    const remaining = existingList.filter((entry) => entry.userId !== actorUserId);
    const mergedMembers = [...new Set([...(call.memberUserIds ?? []), ...memberUserIds])];
    const shouldEndWholeCall = remaining.length === 0 ||
      (endForAll && (actorUserId === call.callerUserId || canEndForAll));

    if (shouldEndWholeCall) {
      const ended: CallRoomRecord = {
        ...call,
        memberUserIds: mergedMembers,
        participants: [],
        status: "ended",
        updatedAt: now,
        endedAt: now,
        endedByUserId: actorUserId
      };
      await Promise.all([
        this.state.storage.put(CALL_KEY, ended),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.clearActivePointers(call);
      const notifyIds = [...new Set([...existingList.map((entry) => entry.userId), ...mergedMembers])];
      await this.realtime.publishToUsers(notifyIds, {
        type: "call.ended",
        callId: ended.callId,
        conversationId: ended.conversationId,
        endedAt: ended.endedAt,
        endedByUserId: ended.endedByUserId
      });
      await this.publishGroupSummary(ended, false);
      return result({ ok: true, call: publicCall(ended, actorUserId) });
    }

    // Remove stale signals to/from the departing participant.
    const storedSignals = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    const filteredSignals = storedSignals.filter(
      (signal) => signal.senderUserId !== actorUserId && signal.targetUserId !== actorUserId
    );
    const updated: CallRoomRecord = {
      ...call,
      memberUserIds: mergedMembers,
      participants: remaining,
      updatedAt: now
    };
    await Promise.all([
      this.state.storage.put(CALL_KEY, updated),
      this.state.storage.put(SIGNALS_KEY, filteredSignals)
    ]);
    await this.realtime.clearActiveCall(actorUserId, call.callId);
    await this.syncActivePointers(updated);

    await Promise.all(remaining.map((entry) =>
      this.realtime.publishToUsers([entry.userId], {
        type: "call.participant.left",
        callId: updated.callId,
        conversationId: updated.conversationId,
        userId: actorUserId,
        participants: remaining.map(publicParticipant),
        call: publicCall(updated, entry.userId)
      })
    ));
    await this.publishGroupSummary(updated, true);
    return result({ ok: true, call: publicCall(updated, actorUserId) });
  }

  private async setMute(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const muted = Boolean(body.muted);
    const call = await this.current();
    if (!call || call.callId !== callId) return notFoundResponse();
    if (!isActive(call)) return conflictResponse("call_not_accepted", "Звонок уже завершён.");

    if (isGroupCall(call)) {
      const participants = [...(call.participants ?? [])];
      const index = participants.findIndex((entry) => entry.userId === actorUserId);
      if (index < 0) return forbidden("call_not_joined", "Вы не подключены к этому групповому звонку.");
      participants[index] = { ...participants[index], muted };
      const updated: CallRoomRecord = { ...call, participants, updatedAt: Date.now() };
      await this.state.storage.put(CALL_KEY, updated);
      await Promise.all(participants.map((entry) =>
        this.realtime.publishToUsers([entry.userId], {
          type: "call.participant.updated",
          callId: updated.callId,
          conversationId: updated.conversationId,
          participant: publicParticipant(participants[index]),
          participants: participants.map(publicParticipant),
          call: publicCall(updated, entry.userId)
        })
      ));
      return result({ ok: true, call: publicCall(updated, actorUserId) });
    }

    if (!participant(call, actorUserId)) return notFoundResponse();
    const otherUserId = actorUserId === call.callerUserId ? call.calleeUserId : call.callerUserId;
    await this.realtime.publishToUsers([otherUserId], {
      type: "call.participant.updated",
      callId: call.callId,
      conversationId: call.conversationId,
      participant: { userId: actorUserId, muted }
    });
    return result({ ok: true, call: publicCall(call, actorUserId) });
  }

  private async getCall(callId: string, viewerUserId: string): Promise<Response> {
    const call = await this.current();
    if (!call || call.callId !== callId) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }
    if (!isGroupCall(call) && !participant(call, viewerUserId)) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }
    return result({ ok: true, call: publicCall(call, viewerUserId) });
  }

  private async transition(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const action = stringValue(body.action);
    const call = await this.current();
    if (!call || call.callId !== callId) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }

    if (isGroupCall(call)) {
      if (action === "decline") {
        // Declining an incoming group ring dismisses only for the declining user.
        return result({ ok: true, call: publicCall(call, actorUserId) });
      }
      if (action === "end") {
        return this.leaveGroup(body);
      }
      return invalid("invalid_call_action", "Неизвестное действие звонка.");
    }

    if (!participant(call, actorUserId)) {
      return result({ ok: false, error: { code: "call_not_found", message: "Звонок не найден." } }, 404);
    }

    if (action === "answer") {
      if (actorUserId !== call.calleeUserId) return forbidden("call_answer_forbidden", "Ответить может только получатель звонка.");
      if (call.status !== "ringing") return conflictResponse("call_not_ringing", "Звонок уже не ожидает ответа.");
      const now = Date.now();
      const updated: CallRoomRecord = { ...call, status: "accepted", answeredAt: now, updatedAt: now,
        calleeSessionId: stringValue(body.actorSessionId) || null };
      await this.state.storage.put(CALL_KEY, updated);
      const [storedSignals] = await Promise.all([
        this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY),
        this.stopRingPushes(),
        this.syncActivePointers(updated),
        this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
          type: "call.answered",
          callId: updated.callId,
          conversationId: updated.conversationId,
          answeredAt: updated.answeredAt
        })
      ]);
      const initialSignals = (storedSignals ?? []).filter((signal) =>
        signal.senderUserId !== actorUserId &&
        (!signal.targetUserId || signal.targetUserId === actorUserId)
      );
      return result({ ok: true, call: publicCall(updated, actorUserId), signals: initialSignals });
    }

    if (action === "decline") {
      if (actorUserId !== call.calleeUserId) return forbidden("call_decline_forbidden", "Отклонить может только получатель звонка.");
      if (call.status !== "ringing") return conflictResponse("call_not_ringing", "Звонок уже не ожидает ответа.");
      const updated = endRecord(call, "declined", actorUserId);
      await Promise.all([
        this.state.storage.put(CALL_KEY, updated),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.stopRingPushes();
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
      const wasRinging = call.status === "ringing";
      const updated = endRecord(call, "ended", actorUserId);
      await Promise.all([
        this.state.storage.put(CALL_KEY, updated),
        this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
      ]);
      await this.stopRingPushes();
      await this.clearActivePointers(updated);
      await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
        type: "call.ended",
        callId: updated.callId,
        conversationId: updated.conversationId,
        endedAt: updated.endedAt,
        endedByUserId: updated.endedByUserId
      });
      if (wasRinging) {
        await this.notifyMissedCall(updated);
      }
      return result({ ok: true, call: publicCall(updated, actorUserId) });
    }
    return invalid("invalid_call_action", "Неизвестное действие звонка.");
  }

  private async handoff(body: Record<string, unknown>): Promise<Response> {
    const call = await this.current();
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const actorSessionId = stringValue(body.actorSessionId);
    if (!call || call.callId !== callId) return notFoundResponse();
    if (call.status !== "accepted") return conflictResponse("call_not_accepted", "Перенос возможен только во время разговора.");
    if (!actorSessionId) return forbidden("invalid_session", "Для переноса нужен вход на новом устройстве.");

    if (isGroupCall(call)) {
      const participants = [...(call.participants ?? [])];
      const index = participants.findIndex((entry) => entry.userId === actorUserId);
      if (index < 0) return notFoundResponse();
      if (participants[index].sessionId === actorSessionId) {
        return result({ ok: true, call: publicCall(call, actorUserId) });
      }
      participants[index] = { ...participants[index], sessionId: actorSessionId };
      const updated: CallRoomRecord = { ...call, participants, updatedAt: Date.now() };
      await this.state.storage.put(CALL_KEY, updated);
      await this.syncActivePointers(updated);
      await this.realtime.publishToUsers(participants.map((entry) => entry.userId), {
        type: "call.handoff",
        callId,
        conversationId: updated.conversationId,
        actorUserId,
        newSessionId: actorSessionId
      });
      return result({ ok: true, call: publicCall(updated, actorUserId) });
    }

    if (!participant(call, actorUserId)) return notFoundResponse();
    const field = actorUserId === call.callerUserId ? "callerSessionId" : "calleeSessionId";
    if (call[field] === actorSessionId) return result({ ok: true, call: publicCall(call, actorUserId) });
    const now = Date.now();
    const updated = { ...call, [field]: actorSessionId, updatedAt: now };
    await this.state.storage.put(CALL_KEY, updated);
    await this.syncActivePointers(updated);
    await this.realtime.publishToUsers([updated.callerUserId, updated.calleeUserId], {
      type: "call.handoff", callId, conversationId: updated.conversationId,
      actorUserId, newSessionId: actorSessionId
    });
    return result({ ok: true, call: publicCall(updated, actorUserId) });
  }

  private async signal(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const kind = stringValue(body.kind);
    const targetUserId = stringValue(body.targetUserId);
    const call = await this.current();
    if (!call || call.callId !== callId) return notFoundResponse();
    if (kind !== "offer" && kind !== "answer" && kind !== "ice" && kind !== "resume") {
      return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
    }

    if (isGroupCall(call)) {
      if (call.status !== "accepted") return conflictResponse("call_not_accepted", "Сигналы разрешены только после ответа.");
      const sender = (call.participants ?? []).find((entry) => entry.userId === actorUserId);
      if (!sender) return forbidden("call_not_joined", "Вы не подключены к этому групповому звонку.");
      if (sender.sessionId && sender.sessionId !== stringValue(body.actorSessionId)) {
        return forbidden("call_moved", "Звонок перенесён на другое устройство.");
      }
      if (!targetUserId || targetUserId === actorUserId ||
          !(call.participants ?? []).some((entry) => entry.userId === targetUserId)) {
        return invalid("invalid_signal_target", "Некорректный получатель сигнала в групповом звонке.");
      }
      const currentSignals = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
      const now = Date.now();
      const signal: CallRoomSignal = {
        sequence: (currentSignals.at(-1)?.sequence ?? 0) + 1,
        callId,
        senderUserId: actorUserId,
        targetUserId,
        kind,
        payload: body.payload,
        createdAt: now
      };
      await Promise.all([
        this.state.storage.put(SIGNALS_KEY, [...currentSignals, signal].slice(-MAX_GROUP_SIGNALS)),
        this.state.storage.put(CALL_KEY, { ...call, updatedAt: now })
      ]);
      await this.realtime.publishToUsers([targetUserId], {
        type: "call.signal",
        callId,
        conversationId: call.conversationId,
        signal
      });
      return result({ ok: true, signal }, 201);
    }

    if (!participant(call, actorUserId)) return notFoundResponse();
    const isCallerPreOffer = call.status === "ringing" &&
      actorUserId === call.callerUserId &&
      (kind === "offer" || kind === "ice");
    if (call.status !== "accepted" && !isCallerPreOffer) {
      return conflictResponse("call_not_accepted", "Сигналы разрешены только после ответа.");
    }
    if (kind === "offer" && actorUserId !== call.callerUserId) return forbidden("call_offer_forbidden", "Offer создаёт инициатор звонка.");
    if (kind === "answer" && actorUserId !== call.calleeUserId) return forbidden("call_answer_signal_forbidden", "Answer создаёт получатель звонка.");
    if (kind === "resume" && actorUserId !== call.calleeUserId) return forbidden("call_resume_forbidden", "Resume запрашивает получатель звонка.");

    const ownerSession = actorUserId === call.callerUserId ? call.callerSessionId : call.calleeSessionId;
    if (ownerSession && ownerSession !== stringValue(body.actorSessionId))
      return forbidden("call_moved", "Звонок перенесён на другое устройство.");
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
    if (call.status === "accepted") {
      const recipientUserId = actorUserId === call.callerUserId ? call.calleeUserId : call.callerUserId;
      await this.realtime.publishToUsers([recipientUserId], {
        type: "call.signal",
        callId,
        conversationId: call.conversationId,
        signal
      });
    }
    return result({ ok: true, signal }, 201);
  }

  private async signalBatch(body: Record<string, unknown>): Promise<Response> {
    const callId = stringValue(body.callId);
    const actorUserId = stringValue(body.actorUserId);
    const items = Array.isArray(body.signals) ? body.signals : null;
    if (!items || !items.length || items.length > 32) {
      return invalid("invalid_call_signal", "Некорректный пакет WebRTC-сигналов.");
    }
    const call = await this.current();
    if (!call || call.callId !== callId) return notFoundResponse();

    if (isGroupCall(call)) {
      if (call.status !== "accepted") return conflictResponse("call_not_accepted", "Сигналы разрешены только после ответа.");
      const sender = (call.participants ?? []).find((entry) => entry.userId === actorUserId);
      if (!sender) return forbidden("call_not_joined", "Вы не подключены к этому групповому звонку.");
      if (sender.sessionId && sender.sessionId !== stringValue(body.actorSessionId)) {
        return forbidden("call_moved", "Звонок перенесён на другое устройство.");
      }
      const participantIds = new Set((call.participants ?? []).map((entry) => entry.userId));
      const validated: Array<{ kind: CallRoomSignal["kind"]; payload: unknown; targetUserId: string }> = [];
      for (const rawItem of items) {
        if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
          return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
        }
        const item = rawItem as Record<string, unknown>;
        const kind = stringValue(item.kind);
        const targetUserId = stringValue(item.targetUserId);
        if (kind !== "offer" && kind !== "answer" && kind !== "ice" && kind !== "resume") {
          return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
        }
        if (!targetUserId || targetUserId === actorUserId || !participantIds.has(targetUserId)) {
          return invalid("invalid_signal_target", "Некорректный получатель сигнала в групповом звонке.");
        }
        validated.push({ kind, payload: item.payload, targetUserId });
      }
      const currentSignals = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
      const now = Date.now();
      let seq = currentSignals.at(-1)?.sequence ?? 0;
      const created: CallRoomSignal[] = validated.map((entry) => ({
        sequence: ++seq,
        callId,
        senderUserId: actorUserId,
        targetUserId: entry.targetUserId,
        kind: entry.kind,
        payload: entry.payload,
        createdAt: now
      }));
      await Promise.all([
        this.state.storage.put(SIGNALS_KEY, [...currentSignals, ...created].slice(-MAX_GROUP_SIGNALS)),
        this.state.storage.put(CALL_KEY, { ...call, updatedAt: now })
      ]);
      const byTarget = new Map<string, CallRoomSignal[]>();
      for (const sig of created) {
        const list = byTarget.get(sig.targetUserId!) ?? [];
        list.push(sig);
        byTarget.set(sig.targetUserId!, list);
      }
      await Promise.all([...byTarget.entries()].map(([targetId, list]) =>
        this.realtime.publishToUsers([targetId], {
          type: "call.signals",
          callId,
          conversationId: call.conversationId,
          signals: list
        })
      ));
      return result({ ok: true, signals: created }, 201);
    }

    if (!participant(call, actorUserId)) return notFoundResponse();
    const ownerSession = actorUserId === call.callerUserId ? call.callerSessionId : call.calleeSessionId;
    if (ownerSession && ownerSession !== stringValue(body.actorSessionId)) {
      return forbidden("call_moved", "Звонок перенесён на другое устройство.");
    }

    const validated: Array<{ kind: CallRoomSignal["kind"]; payload: unknown }> = [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
      }
      const item = rawItem as Record<string, unknown>;
      const kind = stringValue(item.kind);
      if (kind !== "offer" && kind !== "answer" && kind !== "ice" && kind !== "resume") {
        return invalid("invalid_call_signal", "Неизвестный тип WebRTC-сигнала.");
      }
      const isCallerPreOffer = call.status === "ringing" &&
        actorUserId === call.callerUserId &&
        (kind === "offer" || kind === "ice");
      if (call.status !== "accepted" && !isCallerPreOffer) {
        return conflictResponse("call_not_accepted", "Сигналы разрешены только после ответа.");
      }
      if (kind === "offer" && actorUserId !== call.callerUserId) return forbidden("call_offer_forbidden", "Offer создаёт инициатор звонка.");
      if (kind === "answer" && actorUserId !== call.calleeUserId) return forbidden("call_answer_signal_forbidden", "Answer создаёт получатель звонка.");
      if (kind === "resume" && actorUserId !== call.calleeUserId) return forbidden("call_resume_forbidden", "Resume запрашивает получатель звонка.");
      validated.push({ kind, payload: item.payload });
    }

    const currentSignals = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    const now = Date.now();
    let seq = currentSignals.at(-1)?.sequence ?? 0;
    const created: CallRoomSignal[] = validated.map((entry) => ({
      sequence: ++seq,
      callId,
      senderUserId: actorUserId,
      kind: entry.kind,
      payload: entry.payload,
      createdAt: now
    }));

    await Promise.all([
      this.state.storage.put(SIGNALS_KEY, [...currentSignals, ...created].slice(-MAX_SIGNALS)),
      this.state.storage.put(CALL_KEY, { ...call, updatedAt: now })
    ]);

    if (call.status === "accepted") {
      const recipientUserId = actorUserId === call.callerUserId ? call.calleeUserId : call.callerUserId;
      await this.realtime.publishToUsers([recipientUserId], {
        type: "call.signals",
        callId,
        conversationId: call.conversationId,
        signals: created
      });
    }
    return result({ ok: true, signals: created }, 201);
  }

  private async signals(callId: string, viewerUserId: string, after: number): Promise<Response> {
    const call = await this.current();
    if (!call || call.callId !== callId) return notFoundResponse();
    if (isGroupCall(call)) {
      if (!(call.participants ?? []).some((entry) => entry.userId === viewerUserId)) {
        return forbidden("call_not_joined", "Вы не подключены к этому групповому звонку.");
      }
    } else if (!participant(call, viewerUserId)) {
      return notFoundResponse();
    }
    if (call.status !== "accepted") {
      return result({ ok: true, signals: [] });
    }
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const stored = await this.state.storage.get<CallRoomSignal[]>(SIGNALS_KEY) ?? [];
    return result({
      ok: true,
      signals: stored.filter((signal) =>
        signal.sequence > cursor &&
        signal.senderUserId !== viewerUserId &&
        (!signal.targetUserId || signal.targetUserId === viewerUserId)
      )
    });
  }

  private async current(): Promise<CallRoomRecord | null> {
    const call = await this.state.storage.get<CallRoomRecord>(CALL_KEY);
    if (!call || !isStale(call, Date.now())) return call ?? null;
    if (!isActive(call)) return call;
    const wasRinging = call.status === "ringing";
    const expired: CallRoomRecord = {
      ...endRecord(call, "ended", "system-timeout"),
      participants: isGroupCall(call) ? [] : call.participants
    };
    await Promise.all([
      this.state.storage.put(CALL_KEY, expired),
      this.state.storage.put(SIGNALS_KEY, [] as CallRoomSignal[])
    ]);
    await this.stopRingPushes();
    await this.clearActivePointers(call);
    const recipients = isGroupCall(call)
      ? [...new Set([...(call.participants ?? []).map((p) => p.userId), ...(call.memberUserIds ?? [])])]
      : [expired.callerUserId, expired.calleeUserId];
    await this.realtime.publishToUsers(recipients, {
      type: "call.ended",
      callId: expired.callId,
      conversationId: expired.conversationId,
      endedAt: expired.endedAt,
      endedByUserId: expired.endedByUserId,
      reason: "timeout"
    });
    if (isGroupCall(call)) {
      await this.publishGroupSummary(expired, false);
    } else if (wasRinging) {
      await this.notifyMissedCall(expired);
    }
    return expired;
  }

  private async publishGroupSummary(call: CallRoomRecord, active: boolean): Promise<void> {
    const members = [...new Set([
      ...(call.memberUserIds ?? []),
      ...(call.participants ?? []).map((entry) => entry.userId)
    ])];
    if (!members.length) return;
    await this.realtime.publishToUsers(members, {
      type: "call.group.updated",
      conversationId: call.conversationId,
      callId: call.callId,
      active,
      groupTitle: call.groupTitle ?? call.callee.displayName,
      avatarIcon: call.avatarIcon ?? "👥",
      participantCount: active ? (call.participants ?? []).length : 0,
      participants: active ? (call.participants ?? []).map(publicParticipant) : []
    });
  }

  private async startRingPushes(call: CallRoomRecord, now: number): Promise<void> {
    if (!this.notifications || isGroupCall(call)) return;
    if (typeof this.notifications.isConfigured === "function" && !this.notifications.isConfigured()) return;
    await this.state.storage.put<RingPushState>(RING_PUSH_KEY, {
      callId: call.callId,
      pulsesSent: 1,
      startedAt: now
    });
    await this.state.storage.setAlarm(now + RING_PUSH_INTERVAL_MS);
  }

  private async stopRingPushes(): Promise<void> {
    await Promise.all([
      typeof this.state.storage.delete === "function"
        ? Promise.resolve(this.state.storage.delete(RING_PUSH_KEY)).catch(() => {})
        : Promise.resolve(),
      typeof this.state.storage.deleteAlarm === "function"
        ? Promise.resolve(this.state.storage.deleteAlarm()).catch(() => {})
        : Promise.resolve()
    ]);
  }

  private async notifyMissedCall(call: CallRoomRecord): Promise<void> {
    if (!this.notifications?.notifyCallEnded || isGroupCall(call)) return;
    if (typeof this.notifications.isConfigured === "function" && !this.notifications.isConfigured()) return;
    await this.notifications.notifyCallEnded({
      recipientUserId: call.calleeUserId,
      callerDisplayName: call.caller.displayName,
      callId: call.callId,
      conversationId: call.conversationId,
      reason: "missed"
    }).catch((error) => console.warn("[CallRoom] missed call push failed", error));
  }

  private async syncActivePointers(call: CallRoomRecord): Promise<void> {
    const expiresAt = activeExpiresAt(call);
    if (isGroupCall(call)) {
      await Promise.all(
        (call.participants ?? []).map((entry) =>
          this.realtime.setActiveCall(entry.userId, publicCall(call, entry.userId), expiresAt)
        )
      );
      return;
    }
    await Promise.all([
      this.realtime.setActiveCall(call.callerUserId, publicCall(call, call.callerUserId), expiresAt),
      this.realtime.setActiveCall(call.calleeUserId, publicCall(call, call.calleeUserId), expiresAt)
    ]);
  }

  private async clearActivePointers(call: CallRoomRecord): Promise<void> {
    if (isGroupCall(call)) {
      const ids = [...new Set([
        ...(call.participants ?? []).map((entry) => entry.userId),
        call.callerUserId
      ])];
      await Promise.all(ids.map((userId) => this.realtime.clearActiveCall(userId, call.callId)));
      return;
    }
    await Promise.all([
      this.realtime.clearActiveCall(call.callerUserId, call.callId),
      this.realtime.clearActiveCall(call.calleeUserId, call.callId)
    ]);
  }
}

function isGroupCall(call: CallRoomRecord | null | undefined): boolean {
  return call?.kind === "group";
}

function publicParticipant(entry: CallParticipantRecord) {
  return {
    userId: entry.userId,
    username: entry.username,
    displayName: entry.displayName,
    joinedAt: entry.joinedAt,
    muted: Boolean(entry.muted)
  };
}

function publicCall(call: CallRoomRecord, viewerUserId: string) {
  if (isGroupCall(call)) {
    const participants = (call.participants ?? []).map(publicParticipant);
    const mine = (call.participants ?? []).find((entry) => entry.userId === viewerUserId) ?? null;
    return {
      kind: "group" as const,
      callId: call.callId,
      conversationId: call.conversationId,
      callerUserId: call.callerUserId,
      calleeUserId: call.calleeUserId,
      caller: call.caller,
      callee: call.callee,
      groupTitle: call.groupTitle ?? call.callee.displayName,
      avatarIcon: call.avatarIcon ?? "👥",
      status: call.status,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      endedByUserId: call.endedByUserId,
      direction: call.callerUserId === viewerUserId ? "outgoing" : "incoming",
      peer: {
        userId: call.conversationId,
        username: "group",
        displayName: call.groupTitle ?? call.callee.displayName
      },
      participants,
      participantCount: participants.length,
      invitedUserIds: [...(call.invitedUserIds ?? [])],
      joined: Boolean(mine),
      sessionOwnerId: mine?.sessionId ?? null
    };
  }
  return {
    ...call,
    kind: "direct" as const,
    direction: call.callerUserId === viewerUserId ? "outgoing" : "incoming",
    peer: call.callerUserId === viewerUserId ? call.callee : call.caller,
    sessionOwnerId: call.callerUserId === viewerUserId ? (call.callerSessionId ?? null) : (call.calleeSessionId ?? null),
    // Never expose the other participant's session owner.
    callerSessionId: undefined,
    calleeSessionId: undefined
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
    kind: "direct",
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
    endedByUserId: null,
    callerSessionId: stringValue(raw.callerSessionId) || null,
    calleeSessionId: null
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
