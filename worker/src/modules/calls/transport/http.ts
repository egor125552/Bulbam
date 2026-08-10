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
    await authenticate(request);
    return json({ ok: true, iceServers: await service.iceServers() });
  }

  const startMatch = url.pathname.match(/^\/api\/v1\/chats\/([^/]+)\/calls$/);
  if (startMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.start(actor, decodeURIComponent(startMatch[1])) }, { status: 201 });
  }

  const callMatch = url.pathname.match(/^\/api\/v1\/calls\/([^/]+)$/);
  if (callMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return json({ ok: true, call: await service.get(actor, decodeURIComponent(callMatch[1])) });
  }

  const actionMatch = url.pathname.match(/^\/api\/v1\/calls\/([^/]+)\/(answer|decline|end)$/);
  if (actionMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const callId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const call = action === "answer"
      ? await service.answer(actor, callId)
      : action === "decline"
        ? await service.decline(actor, callId)
        : await service.end(actor, callId);
    return json({ ok: true, call });
  }

  const signalsMatch = url.pathname.match(/^\/api\/v1\/calls\/([^/]+)\/signals$/);
  if (signalsMatch) {
    const actor = await authenticate(request);
    const callId = decodeURIComponent(signalsMatch[1]);
    if (request.method === "GET") {
      const signals = await service.signals(actor, callId, url.searchParams.get("after"));
      return json({ ok: true, signals });
    }
    if (request.method === "POST") {
      const signal = await service.signal(actor, callId, await readJsonObject(request));
      return json({ ok: true, signal }, { status: 201 });
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return null;
}
