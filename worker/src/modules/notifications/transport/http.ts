import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { PushNotificationService } from "../application/push-notification-service";

export type AuthenticatePushRequest = (request: Request) => Promise<{ userId: string }>;

export async function handlePushHttp(
  request: Request,
  url: URL,
  service: PushNotificationService,
  authenticate: AuthenticatePushRequest
): Promise<Response | null> {
  if (url.pathname === "/api/v1/push/config") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await authenticate(request);
    return json({ ok: true, ...service.publicConfig() });
  }

  if (url.pathname === "/api/v1/push/subscription") {
    const actor = await authenticate(request);
    if (request.method === "PUT") {
      await service.subscribe(
        actor.userId,
        await readJsonObject(request),
        request.headers.get("user-agent")
      );
      return json({ ok: true }, { status: 201 });
    }
    if (request.method === "DELETE") {
      await service.unsubscribe(actor.userId, await readJsonObject(request));
      return json({ ok: true });
    }
    return methodNotAllowed(["PUT", "DELETE"]);
  }

  if (url.pathname === "/api/v1/push/foreground") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    await service.markForeground(actor.userId, await readJsonObject(request));
    return json({ ok: true });
  }

  return null;
}
