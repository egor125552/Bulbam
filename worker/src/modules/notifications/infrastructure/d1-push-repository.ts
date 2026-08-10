import type { D1Database } from "../../../platform/cloudflare";
import { ensureNotificationSchema } from "./schema";

export interface PushSubscriptionRecord {
  endpoint: string;
  userId: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface SavePushSubscriptionInput extends PushSubscriptionRecord {
  userAgent: string | null;
}

export class D1PushRepository {
  constructor(private readonly db: D1Database) {}

  initialize(): Promise<void> {
    return ensureNotificationSchema(this.db);
  }

  async upsert(input: SavePushSubscriptionInput): Promise<void> {
    await this.initialize();
    const now = Date.now();
    const result = await this.db
      .prepare(
        `INSERT INTO push_subscriptions(
          endpoint, user_id, expiration_time, p256dh, auth, user_agent, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          expiration_time = excluded.expiration_time,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          updated_at = excluded.updated_at`
      )
      .bind(
        input.endpoint,
        input.userId,
        input.expirationTime,
        input.keys.p256dh,
        input.keys.auth,
        input.userAgent,
        now,
        now
      )
      .run();
    if (result.success === false) throw new Error(result.error ?? "Unable to save push subscription");
  }

  async removeForUser(userId: string, endpoint: string): Promise<void> {
    await this.initialize();
    await this.db
      .prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
      .bind(userId, endpoint)
      .run();
  }

  async removeEndpoint(endpoint: string): Promise<void> {
    await this.initialize();
    await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  }

  async listForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    await this.initialize();
    const rows = await this.db
      .prepare(
        `SELECT endpoint, user_id, expiration_time, p256dh, auth
         FROM push_subscriptions
         WHERE user_id = ?
         ORDER BY updated_at DESC`
      )
      .bind(userId)
      .all<{
        endpoint: string;
        user_id: string;
        expiration_time: number | null;
        p256dh: string;
        auth: string;
      }>();

    return (rows.results ?? []).map((row) => ({
      endpoint: row.endpoint,
      userId: row.user_id,
      expirationTime: row.expiration_time === null ? null : Number(row.expiration_time),
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    }));
  }

  async setForeground(userId: string, visible: boolean, now: number): Promise<void> {
    await this.initialize();
    if (!visible) {
      await this.db
        .prepare("DELETE FROM push_foreground_presence WHERE user_id = ?")
        .bind(userId)
        .run();
      return;
    }

    const visibleUntil = now + 30_000;
    await this.db
      .prepare(
        `INSERT INTO push_foreground_presence(user_id, visible_until)
         VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET visible_until = excluded.visible_until`
      )
      .bind(userId, visibleUntil)
      .run();
  }

  async isForeground(userId: string, now: number): Promise<boolean> {
    await this.initialize();
    const row = await this.db
      .prepare("SELECT visible_until FROM push_foreground_presence WHERE user_id = ?")
      .bind(userId)
      .first<{ visible_until: number }>();
    return Boolean(row && Number(row.visible_until) > now);
  }
}
