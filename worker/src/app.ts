import { handleError, json, methodNotAllowed } from "./core/http";
import { IdentityService } from "./modules/identity/application/identity-service";
import { D1IdentityRepository } from "./modules/identity/infrastructure/d1-identity-repository";
import { handleIdentityHttp } from "./modules/identity/transport/http";
import type { Env } from "./platform/cloudflare";

const VERSION = "0.2.0-phase1";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        time: new Date().toISOString()
      });
    }

    const repository = new D1IdentityRepository(env.DB);
    const identity = new IdentityService(repository);

    if (url.pathname === "/api/ready") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      await repository.initialize();
      return json({ ok: true, storage: "ready", version: VERSION });
    }

    const identityResponse = await handleIdentityHttp(request, url, identity);
    if (identityResponse) return identityResponse;

    if (url.pathname === "/api" || url.pathname === "/api/") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        endpoints: [
          "GET /api/health",
          "GET /api/ready",
          "POST /api/v1/auth/register",
          "POST /api/v1/auth/login",
          "GET /api/v1/auth/me",
          "POST /api/v1/auth/logout",
          "GET /api/v1/sessions",
          "DELETE /api/v1/sessions/:sessionId",
          "POST /api/v1/invites"
        ]
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json(
        { ok: false, error: { code: "not_found", message: "API-маршрут не найден." } },
        { status: 404 }
      );
    }

    return env.ASSETS.fetch(request);
  } catch (error) {
    return handleError(error);
  }
}
