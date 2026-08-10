import { handleError, json, methodNotAllowed } from "./core/http";
import { IdentityService } from "./modules/identity/application/identity-service";
import { D1IdentityRepository } from "./modules/identity/infrastructure/d1-identity-repository";
import { handleIdentityHttp, sessionToken } from "./modules/identity/transport/http";
import { MessagingService } from "./modules/messaging/application/messaging-service";
import { D1MessagingRepository } from "./modules/messaging/infrastructure/d1-messaging-repository";
import { handleMessagingHttp } from "./modules/messaging/transport/http";
import { DurableObjectRealtime } from "./modules/realtime/public";
import type { Env } from "./platform/cloudflare";
import { handleSmokeHttp } from "./smoke";

const VERSION = "0.3.0-phase2";

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
        storage: { binding: env.DB ? "configured" : "missing" },
        realtime: { binding: env.REALTIME ? "configured" : "missing" },
        time: new Date().toISOString()
      });
    }

    const storageRequired = url.pathname === "/api/ready" || url.pathname.startsWith("/api/v1/");
    if (storageRequired && !env.DB) return storageBindingMissing();

    const identityRepository = env.DB ? new D1IdentityRepository(env.DB) : null;
    const identity = identityRepository ? new IdentityService(identityRepository) : null;
    const messagingRepository = env.DB ? new D1MessagingRepository(env.DB) : null;
    const realtime = new DurableObjectRealtime(env.REALTIME);
    const messaging = messagingRepository && identity
      ? new MessagingService(
          messagingRepository,
          { findUser: (userId) => identity.findPublicAccountById(userId) },
          realtime
        )
      : null;

    if (url.pathname === "/api/ready") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      if (!identityRepository || !messagingRepository) return storageBindingMissing();

      try {
        await identityRepository.initialize();
        await messagingRepository.initialize();
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

      return json({
        ok: true,
        storage: "ready",
        realtime: realtime.available() ? "ready" : "polling_fallback",
        version: VERSION
      });
    }

    if (identity && messaging) {
      const smokeResponse = await handleSmokeHttp(request, url, env, identity, messaging);
      if (smokeResponse) return smokeResponse;
    }

    if (identity) {
      const identityResponse = await handleIdentityHttp(request, url, identity);
      if (identityResponse) return identityResponse;
    }

    if (identity && messaging) {
      const authenticateMessaging = async (incoming: Request) => {
        const authenticated = await identity.authenticate(sessionToken(incoming));
        return { userId: authenticated.account.userId };
      };
      const messagingResponse = await handleMessagingHttp(
        request,
        url,
        messaging,
        authenticateMessaging
      );
      if (messagingResponse) return messagingResponse;
    }

    if (url.pathname === "/api/v1/realtime" && identity) {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const authenticated = await identity.authenticate(sessionToken(request));
      return realtime.connect(authenticated.account.userId, request);
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        storage: { binding: env.DB ? "configured" : "missing" },
        realtime: { binding: env.REALTIME ? "configured" : "missing" },
        endpoints: [
          "GET /api/health",
          "GET /api/ready",
          "POST /api/v1/auth/register",
          "POST /api/v1/auth/login",
          "GET /api/v1/auth/me",
          "POST /api/v1/auth/logout",
          "GET /api/v1/users/search?q=...",
          "GET /api/v1/sessions",
          "DELETE /api/v1/sessions/:sessionId",
          "POST /api/v1/invites",
          "GET /api/v1/chats",
          "POST /api/v1/chats/direct",
          "GET /api/v1/chats/:conversationId/messages",
          "POST /api/v1/chats/:conversationId/messages",
          "GET /api/v1/realtime (WebSocket)"
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
