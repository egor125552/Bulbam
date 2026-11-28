import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { CallService } from "../application/call-service";

export type AuthenticateCallRequest = (request: Request) => Promise<{ userId: string; sessionId?: string }>;

async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  const contentType = request.headers.get("content-type") ?? "";
  if (contentLength === "0" || !contentType.toLowerCase().includes("application/json")) {
    return {};
  }
  try {
    return await readJsonObject(request);
  } catch {
    return {};
  }
}

export async function handleCallHttp(
  request: Request,
  url: URL,
  service: CallService,
  authenticate: AuthenticateCallRequest
): Promise<Response | null> {
  if (url.pathname === "/api/v1/calls/active") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.active(actor) });
  }

  if (url.pathname === "/api/v1/calls/ice") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return json({ ok: true, iceServers: await service.iceServers(actor) });
  }

  const chatActiveMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/active$/i);
  if (chatActiveMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.activeForConversation(actor, chatActiveMatch[1]) });
  }

  const startMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls$/i);
  if (startMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const body = await readOptionalJsonObject(request);
    const options = Object.prototype.hasOwnProperty.call(body, "invitedUserIds")
      ? { invitedUserIds: body.invitedUserIds }
      : undefined;
    return json({ ok: true, call: await service.start(actor, startMatch[1], options) }, { status: 201 });
  }

  const callMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/([0-9a-f-]{36})$/i
  );
  if (callMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.get(actor, callMatch[1], callMatch[2]) });
  }

  const actionMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/([0-9a-f-]{36})\/(answer|decline|end|join|leave)$/i
  );
  if (actionMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const [conversationId, callId, action] = [actionMatch[1], actionMatch[2], actionMatch[3].toLowerCase()];
    let call;
    let signals;
    if (action === "answer") {
      const answered = await service.answerWithSignals(actor, conversationId, callId);
      call = answered.call;
      signals = answered.signals;
    } else if (action === "join") {
      call = await service.join(actor, conversationId, callId);
    } else if (action === "decline") {
      call = await service.decline(actor, conversationId, callId);
    } else {
      const body = await readOptionalJsonObject(request);
      const endForAll = body.endForAll === true;
      call = action === "leave"
        ? await service.leave(actor, conversationId, callId, { endForAll })
        : await service.end(actor, conversationId, callId, { endForAll });
    }
    return json(signals !== undefined ? { ok: true, call, signals } : { ok: true, call });
  }

  const muteMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/([0-9a-f-]{36})\/mute$/i
  );
  if (muteMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const body = await readJsonObject(request);
    return json({ ok: true, call: await service.setMute(actor, muteMatch[1], muteMatch[2], Boolean(body.muted)) });
  }

  const handoffMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/([0-9a-f-]{36})\/handoff$/i
  );
  if (handoffMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.handoff(actor, handoffMatch[1], handoffMatch[2]) });
  }

  const signalsMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/([0-9a-f-]{36})\/signals$/i
  );
  if (signalsMatch) {
    const actor = await authenticate(request);
    const [conversationId, callId] = [signalsMatch[1], signalsMatch[2]];
    if (request.method === "GET") {
      return json({
        ok: true,
        signals: await service.signals(actor, conversationId, callId, url.searchParams.get("after"))
      });
    }
    if (request.method === "POST") {
      const body = await readJsonObject(request);
      if (Array.isArray(body.signals)) {
        const signals = await service.signalBatch(actor, conversationId, callId, body.signals);
        return json({ ok: true, signals }, { status: 201 });
      }
      const signal = await service.signal(actor, conversationId, callId, body);
      return json({ ok: true, signal }, { status: 201 });
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return null;
}
