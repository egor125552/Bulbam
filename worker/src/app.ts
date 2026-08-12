import { handleError, json, methodNotAllowed } from "./core/http";
import { CallService } from "./modules/calls/application/call-service";
import { handleCallHttp } from "./modules/calls/transport/http";
import { IdentityService } from "./modules/identity/application/identity-service";
import { D1IdentityRepository } from "./modules/identity/infrastructure/d1-identity-repository";
import { handleIdentityHttp, sessionToken } from "./modules/identity/transport/http";
import { VoiceMessageService } from "./modules/media/application/voice-message-service";
import { R2VoiceStorage } from "./modules/media/infrastructure/r2-voice-storage";
import { handleVoiceHttp } from "./modules/media/transport/http";
import { MessagingService } from "./modules/messaging/application/messaging-service";
import { D1MessagingRepository } from "./modules/messaging/infrastructure/d1-messaging-repository";
import { handleMessagingHttp } from "./modules/messaging/transport/http";
import { PushNotificationService } from "./modules/notifications/application/push-notification-service";
import { D1PushRepository } from "./modules/notifications/infrastructure/d1-push-repository";
import { handlePushHttp } from "./modules/notifications/transport/http";
import { DurableObjectRealtime } from "./modules/realtime/public";
import type { Env, ExecutionContextLike } from "./platform/cloudflare";
import { handleSmokeHttp } from "./smoke";

const VERSION = "0.6.0-voice-foundation";

function storageBindingMissing(): Response {
  return json({ ok: false, error: { code: "storage_binding_missing", message: "Хранилище D1 не подключено к Worker." } }, { status: 503 });
}
function callsBindingMissing(): Response {
  return json({ ok: false, error: { code: "calls_binding_missing", message: "CallRoom Durable Object не подключён к Worker." } }, { status: 503 });
}
function voiceMediaBindingMissing(): Response {
  return json({ ok: false, error: { code: "voice_media_binding_missing", message: "Хранилище R2 для голосовых сообщений не подключено." } }, { status: 503 });
}
function turnConfigured(env: Env): boolean {
  return Boolean(
    (env.WEBRTC_CLOUDFLARE_TURN_KEY_ID || env.TURN_KEY_ID) &&
    (env.WEBRTC_CLOUDFLARE_TURN_API_TOKEN || env.TURN_KEY_API_TOKEN)
  ) || Boolean(env.WEBRTC_TURN_SECRET && env.WEBRTC_TURN_URLS) || Boolean(
    env.WEBRTC_STATIC_TURN_URLS &&
    env.WEBRTC_STATIC_TURN_USERNAME &&
    env.WEBRTC_STATIC_TURN_CREDENTIAL
  );
}

export async function handleRequest(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        storage: { binding: env.DB ? "configured" : "missing" },
        media: { voiceR2: env.VOICE_MEDIA ? "configured" : "missing" },
        realtime: { binding: env.REALTIME ? "configured" : "missing" },
        push: { configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) },
        calls: {
          state: env.CALL_ROOM ? "durable_object" : "missing",
          transport: "webrtc",
          relay: turnConfigured(env) ? "turn+stun" : "stun"
        },
        time: new Date().toISOString()
      });
    }

    const storageRequired = url.pathname === "/api/ready" || url.pathname.startsWith("/api/v1/");
    if (storageRequired && !env.DB) return storageBindingMissing();

    const identityRepository = env.DB ? new D1IdentityRepository(env.DB) : null;
    const identity = identityRepository ? new IdentityService(identityRepository) : null;
    const messagingRepository = env.DB ? new D1MessagingRepository(env.DB) : null;
    const pushRepository = env.DB ? new D1PushRepository(env.DB) : null;
    const realtime = new DurableObjectRealtime(env.REALTIME);
    const push = pushRepository ? new PushNotificationService(pushRepository, env) : null;
    const directory = identity ? { findUser: (userId: string) => identity.findPublicAccountById(userId) } : null;
    const messaging = messagingRepository && directory
      ? new MessagingService(
          messagingRepository,
          directory,
          realtime,
          push ?? undefined,
          ctx ? (promise) => ctx.waitUntil(promise) : undefined
        )
      : null;
    const voice = env.VOICE_MEDIA && messagingRepository && messaging
      ? new VoiceMessageService(
          messagingRepository,
          messaging,
          new R2VoiceStorage(env.VOICE_MEDIA),
          realtime
        )
      : null;
    const calls = env.CALL_ROOM && messagingRepository && directory
      ? new CallService(
          env.CALL_ROOM,
          messagingRepository,
          directory,
          env,
          push ?? undefined,
          ctx ? (promise) => ctx.waitUntil(promise) : undefined
        )
      : null;

    if (url.pathname === "/api/ready") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      if (!identityRepository || !messagingRepository || !pushRepository) return storageBindingMissing();
      if (!env.CALL_ROOM) return callsBindingMissing();
      try {
        await identityRepository.initialize();
        await messagingRepository.initialize();
        await pushRepository.initialize();
      } catch (error) {
        console.error("[Bulbam] D1 initialization failed", error);
        return json({ ok: false, error: { code: "storage_initialization_failed", message: "Хранилище D1 подключено, но не смогло инициализироваться." } }, { status: 503 });
      }
      return json({
        ok: true,
        storage: "ready",
        media: env.VOICE_MEDIA ? "voice_r2_ready" : "voice_r2_missing",
        realtime: realtime.available() ? "ready" : "polling_fallback",
        push: push?.publicConfig().configured ? "ready" : "needs_vapid_keys",
        calls: { status: "ready", state: "durable_object", ice: turnConfigured(env) ? "turn+stun" : "stun" },
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

    const authenticate = identity
      ? async (incoming: Request) => {
          const authenticated = await identity.authenticate(sessionToken(incoming));
          return { userId: authenticated.account.userId };
        }
      : null;

    if (identity && push && authenticate) {
      const pushResponse = await handlePushHttp(request, url, push, authenticate);
      if (pushResponse) return pushResponse;
    }
    if (identity && calls && authenticate) {
      const callResponse = await handleCallHttp(request, url, calls, authenticate);
      if (callResponse) return callResponse;
    }
    if (url.pathname.startsWith("/api/v1/") && url.pathname.includes("/calls") && !env.CALL_ROOM) {
      return callsBindingMissing();
    }
    if (identity && voice && authenticate) {
      const voiceResponse = await handleVoiceHttp(request, url, voice, authenticate);
      if (voiceResponse) return voiceResponse;
    }
    if (url.pathname.startsWith("/api/v1/") && url.pathname.includes("/voice") && !env.VOICE_MEDIA) {
      return voiceMediaBindingMissing();
    }
    if (identity && messaging && authenticate) {
      const messagingResponse = await handleMessagingHttp(request, url, messaging, authenticate);
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
        media: { voiceR2: env.VOICE_MEDIA ? "configured" : "missing" },
        realtime: { binding: env.REALTIME ? "configured" : "missing" },
        push: { configured: push?.publicConfig().configured ?? false },
        calls: {
          state: env.CALL_ROOM ? "call-room-durable-object" : "missing",
          transport: "webrtc",
          ice: turnConfigured(env) ? "turn+stun" : "stun"
        },
        endpoints: [
          "GET /api/health", "GET /api/ready",
          "POST /api/v1/auth/register", "POST /api/v1/auth/login", "GET /api/v1/auth/me", "POST /api/v1/auth/logout",
          "GET /api/v1/users/search?q=...", "GET /api/v1/sessions", "DELETE /api/v1/sessions/:sessionId", "POST /api/v1/invites",
          "GET /api/v1/chats", "POST /api/v1/chats/direct", "GET /api/v1/chats/:conversationId/messages", "POST /api/v1/chats/:conversationId/messages",
          "POST /api/v1/chats/:conversationId/receipts/delivered",
          "POST /api/v1/chats/:conversationId/voice/uploads",
          "PUT /api/v1/chats/:conversationId/voice/uploads/:sessionId/parts/:partNumber",
          "POST /api/v1/chats/:conversationId/voice/uploads/:sessionId/complete",
          "DELETE /api/v1/chats/:conversationId/voice/uploads/:sessionId",
          "GET /api/v1/chats/:conversationId/messages/:messageId/voice/audio",
          "POST /api/v1/chats/:conversationId/messages/:messageId/voice/progress",
          "GET|PUT /api/v1/voice/settings",
          "POST /api/v1/chats/:conversationId/calls",
          "GET /api/v1/chats/:conversationId/calls/:callId",
          "POST /api/v1/chats/:conversationId/calls/:callId/answer|decline|end",
          "GET|POST /api/v1/chats/:conversationId/calls/:callId/signals",
          "GET /api/v1/calls/ice",
          "GET /api/v1/push/config", "PUT /api/v1/push/subscription", "DELETE /api/v1/push/subscription", "POST /api/v1/push/foreground",
          "GET /api/v1/realtime (WebSocket)"
        ]
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: { code: "not_found", message: "API-маршрут не найден." } }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    return handleError(error, env.DEBUG_ERRORS === "true");
  }
}
