import { json, methodNotAllowed, readJsonObject } from "./core/http";
import type { IdentityService } from "./modules/identity/application/identity-service";
import type { MessagingService } from "./modules/messaging/application/messaging-service";
import type { Env } from "./platform/cloudflare";

export async function handleSmokeHttp(
  request: Request,
  url: URL,
  env: Env,
  identity: IdentityService,
  messaging: MessagingService
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/v1/smoke/")) return null;

  const configuredSecret = env.SMOKE_SECRET;
  const suppliedSecret = request.headers.get("x-bulbam-smoke-secret") ?? "";
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    return json(
      { ok: false, error: { code: "not_found", message: "API-маршрут не найден." } },
      { status: 404 }
    );
  }

  if (url.pathname === "/api/v1/smoke/invite") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const result = await identity.createSmokeInvite();
    return json({ ok: true, code: result.code }, { status: 201 });
  }

  if (url.pathname === "/api/v1/smoke/cleanup") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body = await readJsonObject(request);
    const prefix = typeof body.prefix === "string" ? body.prefix : "";
    const userIds = await identity.findSmokeUserIds(prefix);
    await messaging.cleanupUsers(userIds);
    await identity.deleteUsersByIds(userIds);
    return json({ ok: true, deletedAccounts: userIds.length });
  }

  return json(
    { ok: false, error: { code: "not_found", message: "API-маршрут не найден." } },
    { status: 404 }
  );
}
