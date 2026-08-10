import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { MessagingService } from "../application/messaging-service";
import type { MessagingActor } from "../domain/models";

export type AuthenticateMessagingRequest = (request: Request) => Promise<MessagingActor>;

export async function handleMessagingHttp(
  request: Request,
  url: URL,
  service: MessagingService,
  authenticate: AuthenticateMessagingRequest
): Promise<Response | null> {
  if (url.pathname === "/api/v1/chats") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    const chats = await service.listChats(actor);
    return json({ ok: true, chats });
  }

  if (url.pathname === "/api/v1/chats/direct") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const body = await readJsonObject(request);
    const chat = await service.openDirectChat(actor, body.userId);
    return json({ ok: true, chat });
  }

  const deliveredMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/receipts\/delivered$/i);
  if (deliveredMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const result = await service.markDelivered(actor, deliveredMatch[1], await readJsonObject(request));
    return json({ ok: true, ...result });
  }

  const messagesMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/messages$/i);
  if (messagesMatch) {
    const actor = await authenticate(request);
    if (request.method === "GET") {
      const messages = await service.listMessages(actor, messagesMatch[1]);
      return json({ ok: true, messages });
    }
    if (request.method === "POST") {
      const result = await service.sendMessage(actor, messagesMatch[1], await readJsonObject(request));
      return json(
        { ok: true, ...result },
        { status: result.duplicate ? 200 : 201 }
      );
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return null;
}
