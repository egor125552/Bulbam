import { handleError, json, methodNotAllowed } from "./core/http";
import { IdentityService } from "./modules/identity/application/identity-service";
import { D1IdentityRepository } from "./modules/identity/infrastructure/d1-identity-repository";
import { handleIdentityHttp } from "./modules/identity/transport/http";
import type { Env } from "./platform/cloudflare";

const VERSION = "0.2.1-phase1";

function storageBindingMissing(): Response {
  return json(
    {
      ok: false,
      error: {
        code: "storage_binding_missing",
        message: "Хранилище D1 не подключено к Worker."
      }
    },
    { status: 503 }
  );
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        storage: {
          binding: env.DB ? "configured" : "missing"
        },
        time: new Date().toISOString()
      });
    }

    const storageRequired = url.pathname === "/api/ready" || url.pathname.startsWith("/api/v1/");
    if (storageRequired && !env.DB) {
      return storageBindingMissing();
    }

    const repository = env.DB ? new D1IdentityRepository(env.DB) : null;
    const identity = repository ? new IdentityService(repository) : null;

    if (url.pathname === "/api/ready") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      if (!repository) return storageBindingMissing();

      try {
        await repository.initialize();
      } catch (error) {
        console.error("[Bulbam] D1 initialization failed", error);
        return json(
          {
            ok: false,
            error: {
              code: "storage_initialization_failed",
              message: "Хранилище D1 подключено, но не смогло инициализироваться."
            }
          },
          { status: 503 }
        );
      }

      return json({ ok: true, storage: "ready", version: VERSION });
    }

    if (identity) {
      const identityResponse = await handleIdentityHttp(request, url, identity);
      if (identityResponse) return identityResponse;
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        storage: {
          binding: env.DB ? "configured" : "missing"
        },
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
    return handleError(error, env.DEBUG_ERRORS === "true");
  }
}
