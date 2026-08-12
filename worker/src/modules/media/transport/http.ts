import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { MessagingActor } from "../../messaging/domain/models";
import type { VoiceMessageService } from "../application/voice-message-service";

export type AuthenticateVoiceRequest = (request: Request) => Promise<MessagingActor>;

export async function handleVoiceHttp(
  request: Request,
  url: URL,
  service: VoiceMessageService,
  authenticate: AuthenticateVoiceRequest
): Promise<Response | null> {
  if (url.pathname === "/api/v1/voice/settings") {
    const actor = await authenticate(request);
    if (request.method === "GET") return json({ ok: true, ...(await service.getSettings(actor)) });
    if (request.method === "PUT") {
      return json({ ok: true, ...(await service.setSettings(actor, await readJsonObject(request))) });
    }
    return methodNotAllowed(["GET", "PUT"]);
  }

  const startMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/voice\/uploads$/i);
  if (startMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const upload = await service.startUpload(actor, startMatch[1], await readJsonObject(request));
    return json({ ok: true, upload }, { status: 201 });
  }

  const partMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/voice\/uploads\/([0-9a-f-]{36})\/parts\/(\d+)$/i
  );
  if (partMatch) {
    if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
    const actor = await authenticate(request);
    const part = await service.uploadPart(
      actor,
      partMatch[1],
      partMatch[2],
      partMatch[3],
      url.searchParams.get("uploadId"),
      request
    );
    return json({ ok: true, part });
  }

  const completeMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/voice\/uploads\/([0-9a-f-]{36})\/complete$/i
  );
  if (completeMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const result = await service.completeUpload(
      actor,
      completeMatch[1],
      completeMatch[2],
      await readJsonObject(request)
    );
    return json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
  }

  const abortMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/voice\/uploads\/([0-9a-f-]{36})$/i
  );
  if (abortMatch) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const actor = await authenticate(request);
    await service.abortUpload(actor, abortMatch[1], abortMatch[2], url.searchParams.get("uploadId"));
    return new Response(null, { status: 204 });
  }

  const audioMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/voice\/audio$/i
  );
  if (audioMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return service.streamVoice(actor, audioMatch[1], audioMatch[2], request.headers);
  }

  const progressMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/voice\/progress$/i
  );
  if (progressMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const result = await service.updateListening(
      actor,
      progressMatch[1],
      progressMatch[2],
      await readJsonObject(request)
    );
    return json({ ok: true, ...result });
  }

  return null;
}
