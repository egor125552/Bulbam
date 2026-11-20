import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { MessagingActor } from "../../messaging/domain/models";
import type { FileMessageService } from "../application/file-message-service";
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

  const socketMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/voice\/uploads\/([0-9a-f-]{36})\/socket$/i
  );
  if (socketMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    return service.openUploadSocket(actor, socketMatch[1], socketMatch[2], request);
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

  const uploadMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/voice\/uploads\/([0-9a-f-]{36})$/i
  );
  if (uploadMatch) {
    const actor = await authenticate(request);
    if (request.method === "GET") {
      return json({ ok: true, upload: await service.getUploadStatus(actor, uploadMatch[1], uploadMatch[2]) });
    }
    if (request.method === "DELETE") {
      await service.abortUpload(actor, uploadMatch[1], uploadMatch[2]);
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed(["GET", "DELETE"]);
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

export async function handleFileHttp(
  request: Request,
  url: URL,
  service: FileMessageService,
  authenticate: AuthenticateVoiceRequest
): Promise<Response | null> {
  const startMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/files\/uploads$/i);
  if (startMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const upload = await service.startUpload(actor, startMatch[1], await readJsonObject(request));
    return json({ ok: true, upload }, { status: 201 });
  }

  const partMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/files\/uploads\/([0-9a-f-]{36})\/parts\/(\d+)$/i
  );
  if (partMatch) {
    if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
    const actor = await authenticate(request);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = await service.uploadPart(actor, partMatch[1], partMatch[2], partMatch[3], bytes);
    return json({ ok: true, ...result });
  }

  const completeMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/files\/uploads\/([0-9a-f-]{36})\/complete$/i
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

  const uploadMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/files\/uploads\/([0-9a-f-]{36})$/i
  );
  if (uploadMatch) {
    const actor = await authenticate(request);
    if (request.method === "GET") {
      return json({ ok: true, upload: await service.getUploadStatus(actor, uploadMatch[1], uploadMatch[2]) });
    }
    if (request.method === "DELETE") {
      await service.abortUpload(actor, uploadMatch[1], uploadMatch[2]);
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed(["GET", "DELETE"]);
  }

  const downloadMatch = url.pathname.match(
    /^\/api\/v1\/chats\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/file$/i
  );
  if (downloadMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
    const actor = await authenticate(request);
    const download = url.searchParams.get("download") === "1";
    return service.serveFile(actor, downloadMatch[1], downloadMatch[2], request.headers, {
      download,
      headOnly: request.method === "HEAD"
    });
  }

  return null;
}
