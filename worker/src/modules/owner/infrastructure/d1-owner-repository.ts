import type { D1Database } from "../../../platform/cloudflare";
import type { Account, AccountRole } from "../../identity/domain/models";
import { ensureIdentitySchema } from "../../identity/infrastructure/schema";
import type { OwnerManagedUserRecord } from "../domain/models";
import type { OwnerRepository } from "../ports/owner-repository";

type Row = Record<string, unknown>;

function asRole(value: unknown): AccountRole {
  return value === "owner" || value === "admin" ? value : "member";
}

export class D1OwnerRepository implements OwnerRepository {
  constructor(private readonly db: D1Database) {}

  initialize(): Promise<void> {
    return ensureIdentitySchema(this.db);
  }

  async listAccountsWithSessionSummary(now: number): Promise<OwnerManagedUserRecord[]> {
    await this.initialize();
    const rows = await this.db
      .prepare(`
        SELECT
          a.user_id,
          a.username,
          a.display_name,
          a.role,
          a.created_at,
          (
            SELECT COUNT(*)
            FROM sessions s
            WHERE s.user_id = a.user_id AND s.revoked_at IS NULL AND s.expires_at > ?
          ) AS active_sessions_count,
          (
            SELECT COUNT(*)
            FROM sessions s
            WHERE s.user_id = a.user_id AND (s.revoked_at IS NOT NULL OR s.expires_at <= ?)
          ) AS restorable_sessions_count,
          (
            SELECT MAX(s.last_seen_at)
            FROM sessions s
            WHERE s.user_id = a.user_id
          ) AS last_session_at,
          (
            SELECT s.device_name
            FROM sessions s
            WHERE s.user_id = a.user_id
            ORDER BY s.last_seen_at DESC
            LIMIT 1
          ) AS last_device_name
        FROM accounts a
        WHERE a.disabled_at IS NULL
        ORDER BY
          CASE a.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
          a.created_at ASC
        LIMIT 200
      `)
      .bind(now, now)
      .all<Row>();

    return (rows.results ?? []).map((row) => ({
      userId: String(row.user_id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: asRole(row.role),
      createdAt: Number(row.created_at),
      activeSessionsCount: Number(row.active_sessions_count ?? 0),
      restorableSessionsCount: Number(row.restorable_sessions_count ?? 0),
      lastSessionAt: row.last_session_at === null ? null : Number(row.last_session_at),
      lastDeviceName: row.last_device_name === null ? null : String(row.last_device_name)
    }));
  }

  async findAccountById(userId: string): Promise<Account | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT user_id, username, display_name, role, created_at
        FROM accounts
        WHERE user_id = ? AND disabled_at IS NULL
        LIMIT 1
      `)
      .bind(userId)
      .first<Row>();
    if (!row) return null;
    return {
      userId: String(row.user_id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: asRole(row.role),
      createdAt: Number(row.created_at)
    };
  }

  async restoreLatestSession(
    userId: string,
    now: number,
    newExpiresAt: number
  ): Promise<{ restored: boolean; deviceName: string | null }> {
    await this.initialize();
    const latest = await this.db
      .prepare(`
        SELECT session_id, device_name
        FROM sessions
        WHERE user_id = ?
        ORDER BY last_seen_at DESC
        LIMIT 1
      `)
      .bind(userId)
      .first<Row>();
    if (!latest) return { restored: false, deviceName: null };

    const sessionId = String(latest.session_id);
    const updated = await this.db
      .prepare(`
        UPDATE sessions
        SET revoked_at = NULL,
            expires_at = MAX(expires_at, ?),
            last_seen_at = ?
        WHERE session_id = ? AND user_id = ?
      `)
      .bind(newExpiresAt, now, sessionId, userId)
      .run();

    return {
      restored: (updated.meta?.changes ?? 0) === 1,
      deviceName: String(latest.device_name ?? "")
    };
  }

  async revokeAllSessionsForUser(userId: string, now: number): Promise<number> {
    await this.initialize();
    const result = await this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(now, userId)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  async createOneTimeLoginToken(input: {
    tokenHash: string;
    userId: string;
    createdByUserId: string;
    now: number;
    expiresAt: number;
  }): Promise<void> {
    await this.initialize();
    await this.db.batch([
      this.db
        .prepare("DELETE FROM owner_login_tokens WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at <= ?)")
        .bind(input.userId, input.now),
      this.db
        .prepare(`
          INSERT INTO owner_login_tokens (
            token_hash, user_id, created_by_user_id, created_at, expires_at, used_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
        `)
        .bind(
          input.tokenHash,
          input.userId,
          input.createdByUserId,
          input.now,
          input.expiresAt
        )
    ]);
  }

  async consumeOneTimeLoginToken(tokenHash: string, now: number): Promise<Account | null> {
    await this.initialize();
    const updated = await this.db
      .prepare(`
        UPDATE owner_login_tokens
        SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      `)
      .bind(now, tokenHash, now)
      .run();

    if ((updated.meta?.changes ?? 0) !== 1) return null;

    const row = await this.db
      .prepare(`
        SELECT a.user_id, a.username, a.display_name, a.role, a.created_at
        FROM owner_login_tokens t
        JOIN accounts a ON a.user_id = t.user_id
        WHERE t.token_hash = ? AND a.disabled_at IS NULL
        LIMIT 1
      `)
      .bind(tokenHash)
      .first<Row>();

    if (!row) return null;
    return {
      userId: String(row.user_id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: asRole(row.role),
      createdAt: Number(row.created_at)
    };
  }

  async deleteAccountAndRecordNotice(input: {
    userId: string;
    usernameHash: string;
    reason: string;
    now: number;
  }): Promise<boolean> {
    await this.initialize();
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM owner_login_tokens WHERE user_id = ?").bind(input.userId),
      this.db.prepare("DELETE FROM admin_recovery_requests WHERE user_id = ?").bind(input.userId),
      this.db.prepare("DELETE FROM password_recovery_codes WHERE user_id = ?").bind(input.userId),
      this.db.prepare("DELETE FROM passkey_challenges WHERE user_id = ?").bind(input.userId),
      this.db.prepare("DELETE FROM account_passkeys WHERE user_id = ?").bind(input.userId),
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(input.userId),
      this.db.prepare("UPDATE invites SET created_by_user_id = NULL WHERE created_by_user_id = ?").bind(input.userId),
      this.db.prepare("DELETE FROM accounts WHERE user_id = ? AND role <> 'owner'").bind(input.userId),
      this.db.prepare("DELETE FROM invites WHERE used_by_user_id = ?").bind(input.userId),
      this.db.prepare(`
        INSERT INTO deleted_account_notices (username_hash, reason, deleted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(username_hash) DO UPDATE SET
          reason = excluded.reason,
          deleted_at = excluded.deleted_at
      `).bind(input.usernameHash, input.reason, input.now)
    ]);
    return (results[7]?.meta?.changes ?? 0) === 1;
  }
}
