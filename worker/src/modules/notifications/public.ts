import type { Env } from "../../platform/cloudflare";
import {
  PushNotificationService,
  type IncomingCallNotificationPublisher
} from "./application/push-notification-service";
import { D1PushRepository } from "./infrastructure/d1-push-repository";

export type {
  CallEndedNotificationInput,
  IncomingCallNotificationInput,
  IncomingCallNotificationPublisher
} from "./application/push-notification-service";

export function createCallNotificationPublisher(env: Env): IncomingCallNotificationPublisher | null {
  if (!env.DB) return null;
  const service = new PushNotificationService(new D1PushRepository(env.DB), env);
  return service.isConfigured() ? service : null;
}
