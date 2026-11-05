import type { D1Database } from "../../../platform/cloudflare";
import { ensureNotificationSchema } from "./schema";

export interface PushSubscriptionRecord {
  endpoint: string;
  userId: string;
  sessionId: string;
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
          endpoint, user_id, session_id, expiration_time, p256dh, auth, user_agent, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          session_id = excluded.session_id,
          expiration_time = excluded.expiration_time,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          updated_at = excluded.updated_at`
      )
      .bind(
        input.endpoint,
        input.userId,
        input.sessionId,
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

  async isCurrentSession(subscription:PushSubscriptionRecord):Promise<boolean> {
    await this.initialize();
    return Boolean(await this.db.prepare(`SELECT 1 AS active FROM sessions WHERE
      user_id=? AND session_id=? AND revoked_at IS NULL AND expires_at>?`)
      .bind(subscription.userId,subscription.sessionId,Date.now()).first());
  }

  async removeEndpoint(endpoint: string): Promise<void> {
    await this.initialize();
    await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  }

  async listForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    await this.initialize();
    const rows = await this.db
      .prepare(
        `SELECT p.endpoint, p.user_id, p.session_id, p.expiration_time, p.p256dh, p.auth
         FROM push_subscriptions AS p
         JOIN sessions AS s ON s.session_id=p.session_id AND s.user_id=p.user_id
         WHERE p.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
         ORDER BY p.updated_at DESC`
      )
      .bind(userId,Date.now())
      .all<{
        endpoint: string;
        user_id: string;
        session_id: string;
        expiration_time: number | null;
        p256dh: string;
        auth: string;
      }>();

    return (rows.results ?? []).map((row) => ({
      endpoint: row.endpoint,
      userId: row.user_id,
      sessionId: row.session_id,
      expirationTime: row.expiration_time === null ? null : Number(row.expiration_time),
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    }));
  }

  async removeRevokedForUser(userId:string):Promise<void> {
    await this.initialize();
    await this.db.prepare(`DELETE FROM push_subscriptions
      WHERE user_id=? AND (session_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM sessions s WHERE s.session_id=push_subscriptions.session_id
        AND s.user_id=push_subscriptions.user_id AND s.revoked_at IS NULL AND s.expires_at>?
      ))`).bind(userId,Date.now()).run();
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
