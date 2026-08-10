import webpush from "web-push";
import { badRequest } from "../../../core/errors";
import type { Env } from "../../../platform/cloudflare";
import type { DurableObjectRealtime } from "../../realtime/public";
import type {
  D1PushRepository,
  PushSubscriptionRecord
} from "../infrastructure/d1-push-repository";

export interface MessageNotificationInput {
  recipientUserId: string;
  senderDisplayName: string;
  conversationId: string;
  messageId: string;
  text: string;
}

export interface MessageNotificationPublisher {
  notifyNewMessage(input: MessageNotificationInput): Promise<void>;
}

export class PushNotificationService implements MessageNotificationPublisher {
  constructor(
    private readonly repository: D1PushRepository,
    private readonly realtime: DurableObjectRealtime,
    private readonly env: Env
  ) {}

  initialize(): Promise<void> {
    return this.repository.initialize();
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

  async notifyNewMessage(input: MessageNotificationInput): Promise<void> {
    if (!this.configured()) return;

    // Visible clients keep receiving the existing WebSocket event. Push is the
    // fallback for a user whose Bulbam window is not currently active.
    if (await this.realtime.hasActiveConnections(input.recipientUserId)) return;

    const subscriptions = await this.repository.listForUser(input.recipientUserId);
    if (!subscriptions.length) return;

    const payload = JSON.stringify({
      kind: "message",
      title: input.senderDisplayName,
      body: notificationPreview(input.text),
      tag: `chat-${input.conversationId}`,
      icon: "/icon.svg",
      data: {
        url: `/?chat=${encodeURIComponent(input.conversationId)}`,
        conversationId: input.conversationId,
        messageId: input.messageId
      }
    });

    await Promise.all(subscriptions.map((subscription) => this.send(subscription, payload)));
  }

  private configured(): boolean {
    return Boolean(
      this.env.VAPID_PUBLIC_KEY &&
      this.env.VAPID_PRIVATE_KEY &&
      this.env.VAPID_SUBJECT
    );
  }

  private async send(subscription: PushSubscriptionRecord, payload: string): Promise<void> {
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
          TTL: 60 * 60,
          urgency: "high"
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
