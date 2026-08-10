import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { CallService } from "../application/call-service";

export type AuthenticateCallRequest = (request: Request) => Promise<{ userId: string }>;

export async function handleCallHttp(
  request: Request,
  url: URL,
  service: CallService,
  authenticate: AuthenticateCallRequest
): Promise<Response | null> {
  if (url.pathname === "/api/v1/calls/ice") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return json({ ok: true, iceServers: await service.iceServers(actor) });
  }

  const startMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls$/i);
  if (startMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.start(actor, startMatch[1]) }, { status: 201 });
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
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/calls\/([0-9a-f-]{36})\/(answer|decline|end)$/i
  );
  if (actionMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const [conversationId, callId, action] = [actionMatch[1], actionMatch[2], actionMatch[3]];
    const call = action === "answer"
      ? await service.answer(actor, conversationId, callId)
      : action === "decline"
        ? await service.decline(actor, conversationId, callId)
        : await service.end(actor, conversationId, callId);
    return json({ ok: true, call });
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
      const signal = await service.signal(
        actor,
        conversationId,
        callId,
        await readJsonObject(request)
      );
      return json({ ok: true, signal }, { status: 201 });
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return null;
}
