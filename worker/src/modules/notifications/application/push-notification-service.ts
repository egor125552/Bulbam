import webpush from "web-push";
import { badRequest } from "../../../core/errors";
import type { Env } from "../../../platform/cloudflare";
import type {
  D1PushRepository,
  PushSubscriptionRecord
} from "../infrastructure/d1-push-repository";

export interface MessageNotificationInput {
  recipientUserId: string;
  senderDisplayName: string;
  groupTitle?: string;
  conversationId: string;
  messageId: string;
  text: string;
}

export interface IncomingCallNotificationInput {
  recipientUserId: string;
  callerDisplayName: string;
  callId: string;
  conversationId: string;
  sequence?: number;
  expiresAt?: number;
}

export interface CallEndedNotificationInput {
  recipientUserId: string;
  callerDisplayName: string;
  callId: string;
  conversationId: string;
  reason: "missed" | "answered" | "declined" | "ended";
}

export interface MessageNotificationPublisher {
  notifyNewMessage(input: MessageNotificationInput): Promise<void>;
}

export interface IncomingCallNotificationPublisher {
  isConfigured?(): boolean;
  notifyIncomingCall(input: IncomingCallNotificationInput): Promise<void>;
  notifyCallEnded?(input: CallEndedNotificationInput): Promise<void>;
}

export class PushNotificationService
implements MessageNotificationPublisher, IncomingCallNotificationPublisher {
  constructor(
    private readonly repository: D1PushRepository,
    private readonly env: Env
  ) {}

  initialize(): Promise<void> {
    return this.repository.initialize();
  }

  isConfigured(): boolean {
    return this.configured();
  }

  publicConfig() {
    return {
      configured: this.configured(),
      vapidPublicKey: this.configured() ? this.env.VAPID_PUBLIC_KEY! : null
    };
  }

  async subscribe(userId: string, raw: Record<string, unknown>, userAgent: string | null): Promise<void> {
    if (!this.configured()) {
      badRequest(
        "push_not_configured",
        "Push-уведомления на сервере ещё не настроены."
      );
    }
    const subscription = validateSubscription(raw);
    await this.repository.upsert({
      ...subscription,
      userId,
      userAgent
    });
  }

  async unsubscribe(userId: string, raw: Record<string, unknown>): Promise<void> {
    const endpoint = validateEndpoint(raw.endpoint);
    await this.repository.removeForUser(userId, endpoint);
  }

  async markForeground(userId: string, raw: Record<string, unknown>): Promise<void> {
    if (typeof raw.visible !== "boolean") {
      badRequest("invalid_push_presence", "Некорректное состояние видимости приложения.");
    }
    await this.repository.setForeground(userId, raw.visible, Date.now());
  }

  async notifyNewMessage(input: MessageNotificationInput): Promise<void> {
    await this.notifyWhenBackground(input.recipientUserId, {
      kind: "message",
      title: input.groupTitle??input.senderDisplayName,
      body: input.groupTitle?`${input.senderDisplayName}: ${notificationPreview(input.text)}`:notificationPreview(input.text),
      tag: `chat-${input.conversationId}`,
      icon: "/icon.svg",
      data: {
        url: `/?chat=${encodeURIComponent(input.conversationId)}`,
        conversationId: input.conversationId,
        messageId: input.messageId
      }
    });
  }

  async notifyIncomingCall(input: IncomingCallNotificationInput): Promise<void> {
    // Calls are latency-sensitive. Always send the push to subscribed devices;
    // the Service Worker suppresses the system notification when a Bulbam
    // window is actually visible. Use a stable tag + RFC 8030 topic so repeated
    // ringing pulses collapse in transit and replace the previous notification
    // on browsers that implement W3C `tag` replacement.
    //
    // Apple Web Push (iOS/iPadOS/macOS Safari via `*.push.apple.com`) does NOT
    // reliably replace already-delivered notifications via `tag` or
    // `notification.close()` (WebKit Bugs 258922 & 280766). Sending repeat
    // ringing pulses to Apple endpoints creates stacked duplicates ("Grouped")
    // in iOS Notification Center, so Apple endpoints receive only pulse #1.
    const sequence = input.sequence ?? 1;
    await this.notifyAll(input.recipientUserId, {
      kind: "call",
      title: `Входящий звонок — ${input.callerDisplayName}`,
      body: "Нажмите, чтобы открыть Бульбам и ответить.",
      tag: `call-${input.callId}`,
      renotify: true,
      replace: true,
      sequence,
      expiresAt: input.expiresAt ?? null,
      icon: "/icon.svg",
      data: {
        url: `/?chat=${encodeURIComponent(input.conversationId)}&call=${encodeURIComponent(input.callId)}`,
        callId: input.callId,
        conversationId: input.conversationId
      }
    }, 15, callPushTopic(input.callId), {
      skipAppleEndpoints: sequence > 1
    });
  }

  async notifyCallEnded(input: CallEndedNotificationInput): Promise<void> {
    // Reuse the exact same tag and RFC 8030 topic so any queued ringing push
    // is collapsed at the push service and the active ringing banner is cleanly
    // replaced by a single missed/ended notification on compliant browsers.
    // Skip Apple Web Push endpoints: because WebKit does not replace the prior
    // ringing notification in-place, a second push would stack into "Grouped".
    await this.notifyAll(input.recipientUserId, {
      kind: "call-ended",
      title: `Пропущенный звонок — ${input.callerDisplayName}`,
      body: "Звонок завершён.",
      tag: `call-${input.callId}`,
      renotify: false,
      replace: true,
      icon: "/icon.svg",
      data: {
        url: `/?chat=${encodeURIComponent(input.conversationId)}`,
        callId: input.callId,
        conversationId: input.conversationId,
        reason: input.reason
      }
    }, 60, callPushTopic(input.callId), {
      skipAppleEndpoints: true
    });
  }

  async notifyAdminRecoveryRequest(recipientUserId:string):Promise<void> {
    await this.notifyAll(recipientUserId,{
      kind:"admin-recovery",title:"Бульбам: запрос восстановления",
      body:"Новая заявка. Прежде чем одобрить, проверьте личность пользователя.",
      tag:"admin-recovery",icon:"/icon.svg",data:{url:"/?reviewRecovery=1"}
    },3600);
  }

  private async notifyWhenBackground(
    recipientUserId: string,
    payload: Record<string, unknown>,
    ttl = 60 * 60
  ): Promise<void> {
    if (!this.configured()) return;
    if (await this.repository.isForeground(recipientUserId, Date.now())) return;
    await this.notifyAll(recipientUserId, payload, ttl);
  }

  private async notifyAll(
    recipientUserId: string,
    payload: Record<string, unknown>,
    ttl: number,
    topic?: string,
    options?: { skipAppleEndpoints?: boolean }
  ): Promise<void> {
    if (!this.configured()) return;
    const allSubscriptions = await this.repository.listForUser(recipientUserId);
    const subscriptions = options?.skipAppleEndpoints
      ? allSubscriptions.filter((subscription) => !isAppleWebPushEndpoint(subscription.endpoint))
      : allSubscriptions;
    if (!subscriptions.length) return;
    const encoded = JSON.stringify(payload);
    await Promise.all(subscriptions.map((subscription) => this.send(subscription, encoded, ttl, topic)));
  }

  private configured(): boolean {
    return Boolean(
      this.env.VAPID_PUBLIC_KEY &&
      this.env.VAPID_PRIVATE_KEY &&
      this.env.VAPID_SUBJECT
    );
  }

  private async send(
    subscription: PushSubscriptionRecord,
    payload: string,
    ttl: number,
    topic?: string
  ): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys
        },
        payload,
        {
          vapidDetails: {
            subject: this.env.VAPID_SUBJECT!,
            publicKey: this.env.VAPID_PUBLIC_KEY!,
            privateKey: this.env.VAPID_PRIVATE_KEY!
          },
          TTL: ttl,
          urgency: "high",
          ...(topic ? { topic } : {})
        }
      );
    } catch (error) {
      const statusCode = webPushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        await this.repository.removeEndpoint(subscription.endpoint);
        return;
      }
      console.warn(`[Push] delivery failed with status ${statusCode || "unknown"}`, error);
    }
  }
}

export function isAppleWebPushEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "push.apple.com" || host.endsWith(".push.apple.com");
  } catch {
    return false;
  }
}

export function callPushTopic(callId: string): string {
  // RFC 8030 Topic must be <= 32 URL-safe base64 characters ([A-Za-z0-9_-]).
  const compact = String(callId).replace(/[^A-Za-z0-9_-]/g, "").replace(/-/g, "").slice(0, 27);
  return `call-${compact || "active"}`;
}

function validateSubscription(raw: Record<string, unknown>): Omit<PushSubscriptionRecord, "userId"> {
  const endpoint = validateEndpoint(raw.endpoint);
  const expirationTime = raw.expirationTime === null || raw.expirationTime === undefined
    ? null
    : validateExpiration(raw.expirationTime);
  const keys = raw.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    badRequest("invalid_push_subscription", "В push-подписке отсутствуют ключи.");
  }
  const keyObject = keys as Record<string, unknown>;
  const p256dh = validatePushKey(keyObject.p256dh, "p256dh");
  const auth = validatePushKey(keyObject.auth, "auth");
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 4096) {
    badRequest("invalid_push_endpoint", "Некорректный endpoint push-подписки.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    badRequest("invalid_push_endpoint", "Некорректный endpoint push-подписки.");
  }
  if (parsed.protocol !== "https:") {
    badRequest("invalid_push_endpoint", "Push endpoint должен использовать HTTPS.");
  }
  return value;
}

function validateExpiration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    badRequest("invalid_push_expiration", "Некорректный срок push-подписки.");
  }
  return Math.floor(value);
}

function validatePushKey(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
  ) {
    badRequest("invalid_push_key", `Некорректный ключ push-подписки: ${name}.`);
  }
  return value;
}

function notificationPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact;
}

function webPushStatusCode(error: unknown): number {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return 0;
  const value = Number((error as { statusCode?: unknown }).statusCode);
  return Number.isFinite(value) ? value : 0;
}
