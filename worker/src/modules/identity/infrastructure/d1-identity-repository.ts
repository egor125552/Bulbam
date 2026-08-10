import type { D1Database } from "../../../platform/cloudflare";
import type {
  Account,
  AccountCredentials,
  AccountRole,
  AuthenticatedSession,
  Invite,
  PublicAccount,
  Session
} from "../domain/models";
import { normalizeDisplayNameForSearch } from "../domain/validation";
import type { IdentityRepository, RegisterAccountResult } from "../ports/identity-repository";
import { ensureIdentitySchema } from "./schema";

type Row = Record<string, unknown>;

export class D1IdentityRepository implements IdentityRepository {
  constructor(private readonly db: D1Database) {}

  initialize(): Promise<void> {
    return ensureIdentitySchema(this.db);
  }

  async findAccountCredentialsByUsername(username: string): Promise<AccountCredentials | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT user_id, username, display_name, password_hash, role, created_at
        FROM accounts
        WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL
        LIMIT 1
      `)
      .bind(username)
      .first<Row>();
    return row ? mapAccountCredentials(row) : null;
  }

  async findPublicAccountById(userId: string): Promise<PublicAccount | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT user_id, username, display_name
        FROM accounts
        WHERE user_id = ? AND disabled_at IS NULL
        LIMIT 1
      `)
      .bind(userId)
      .first<Row>();
    return row ? mapPublicAccount(row) : null;
  }

  async searchPublicAccounts(query: string, currentUserId: string, limit: number): Promise<PublicAccount[]> {
    await this.initialize();
    const usernameQuery = query.trim().replace(/^@/, "").toLowerCase();
    const displayQuery = normalizeDisplayNameForSearch(query.replace(/^@/, ""));
    const usernamePrefix = `${escapeLike(usernameQuery)}%`;
    const displayPrefix = `${escapeLike(displayQuery)}%`;
    const displayContains = `%${escapeLike(displayQuery)}%`;

    const result = await this.db
      .prepare(`
        SELECT user_id, username, display_name
        FROM accounts
        WHERE disabled_at IS NULL
          AND user_id <> ?
          AND (
            username LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR display_name_search LIKE ? ESCAPE '\\'
          )
        ORDER BY
          CASE
            WHEN username = ? COLLATE NOCASE THEN 0
            WHEN username LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
            WHEN display_name_search = ? THEN 2
            WHEN display_name_search LIKE ? ESCAPE '\\' THEN 3
            ELSE 4
          END,
          display_name_search,
          username
        LIMIT ?
      `)
      .bind(
        currentUserId,
        usernamePrefix,
        displayContains,
        usernameQuery,
        usernamePrefix,
        displayQuery,
        displayPrefix,
        limit
      )
      .all<Row>();

    return (result.results ?? []).map(mapPublicAccount);
  }

  async registerAccountWithInvite(input: {
    userId: string;
    username: string;
    displayName: string;
    passwordHash: string;
    inviteCodeHash: string;
    now: number;
  }): Promise<RegisterAccountResult> {
    await this.initialize();

    const invite = await this.db
      .prepare(`
        SELECT invite_id, role_grant
        FROM invites
        WHERE code_hash = ?
          AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1
      `)
      .bind(input.inviteCodeHash, input.now)
      .first<Row>();
    if (!invite) return { status: "invite_invalid" };

    const existing = await this.db
      .prepare("SELECT user_id FROM accounts WHERE username = ? COLLATE NOCASE LIMIT 1")
      .bind(input.username)
      .first<Row>();
    if (existing) return { status: "username_taken" };

    const inviteId = String(invite.invite_id);
    const role = asRole(invite.role_grant);

    try {
      const results = await this.db.batch([
        this.db
          .prepare(`
            INSERT INTO accounts (
              user_id, username, display_name, display_name_search, password_hash,
              role, invite_id, created_at, disabled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `)
          .bind(
            input.userId,
            input.username,
            input.displayName,
            normalizeDisplayNameForSearch(input.displayName),
            input.passwordHash,
            role,
            inviteId,
            input.now
          ),
        this.db
          .prepare(`
            UPDATE invites
            SET used_at = ?, used_by_user_id = ?
            WHERE invite_id = ? AND used_at IS NULL
          `)
          .bind(input.now, input.userId, inviteId)
      ]);

      if ((results[1]?.meta?.changes ?? 0) !== 1) {
        return { status: "conflict" };
      }

      return {
        status: "created",
        account: {
          userId: input.userId,
          username: input.username,
          displayName: input.displayName,
          role,
          createdAt: input.now
        }
      };
    } catch (error) {
      const usernameAfterRace = await this.db
        .prepare("SELECT user_id FROM accounts WHERE username = ? COLLATE NOCASE LIMIT 1")
        .bind(input.username)
        .first<Row>();
      if (usernameAfterRace) return { status: "username_taken" };

      const inviteAfterRace = await this.db
        .prepare("SELECT used_at FROM invites WHERE invite_id = ? LIMIT 1")
        .bind(inviteId)
        .first<Row>();
      if (!inviteAfterRace || inviteAfterRace.used_at !== null) return { status: "invite_invalid" };

      console.error("[IdentityRepository] registration transaction failed", error);
      return { status: "conflict" };
    }
  }

  async createSession(input: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    deviceName: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<Session> {
    await this.initialize();
    await this.db
      .prepare(`
        INSERT INTO sessions (
          session_id, user_id, token_hash, device_name, created_at, expires_at, last_seen_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .bind(
        input.sessionId,
        input.userId,
        input.tokenHash,
        input.deviceName,
        input.createdAt,
        input.expiresAt,
        input.createdAt
      )
      .run();

    return {
      sessionId: input.sessionId,
      userId: input.userId,
      deviceName: input.deviceName,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      lastSeenAt: input.createdAt,
      revokedAt: null
    };
  }

  async findAuthenticatedSession(tokenHash: string, now: number): Promise<AuthenticatedSession | null> {
    await this.initialize();
    const row = await this.db
      .prepare(`
        SELECT
          a.user_id,
          a.username,
          a.display_name,
          a.role,
          a.created_at AS account_created_at,
          s.session_id,
          s.device_name,
          s.created_at AS session_created_at,
          s.expires_at,
          s.last_seen_at,
          s.revoked_at
        FROM sessions s
        JOIN accounts a ON a.user_id = s.user_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > ?
          AND a.disabled_at IS NULL
        LIMIT 1
      `)
      .bind(tokenHash, now)
      .first<Row>();
    if (!row) return null;

    return {
      account: {
        userId: String(row.user_id),
        username: String(row.username),
        displayName: String(row.display_name),
        role: asRole(row.role),
        createdAt: Number(row.account_created_at)
      },
      session: {
        sessionId: String(row.session_id),
        userId: String(row.user_id),
        deviceName: String(row.device_name),
        createdAt: Number(row.session_created_at),
        expiresAt: Number(row.expires_at),
        lastSeenAt: Number(row.last_seen_at),
        revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
      }
    };
  }

  async touchSession(sessionId: string, now: number): Promise<void> {
    await this.initialize();
    await this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL")
      .bind(now, sessionId)
      .run();
  }

  async listSessions(userId: string, now: number): Promise<Session[]> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        SELECT session_id, user_id, device_name, created_at, expires_at, last_seen_at, revoked_at
        FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC
      `)
      .bind(userId, now)
      .all<Row>();
    return (result.results ?? []).map(mapSession);
  }

  async revokeSession(userId: string, sessionId: string, now: number): Promise<boolean> {
    await this.initialize();
    const result = await this.db
      .prepare(`
        UPDATE sessions
        SET revoked_at = ?
        WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL
      `)
      .bind(now, sessionId, userId)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async createInvite(input: {
    inviteId: string;
    codeHash: string;
    createdByUserId: string | null;
    roleGrant: AccountRole;
    createdAt: number;
    expiresAt: number;
  }): Promise<Invite> {
    await this.initialize();
    await this.db
      .prepare(`
        INSERT INTO invites (
          invite_id, code_hash, created_by_user_id, role_grant, created_at, expires_at, used_at, used_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `)
      .bind(
        input.inviteId,
        input.codeHash,
        input.createdByUserId,
        input.roleGrant,
        input.createdAt,
        input.expiresAt
      )
      .run();

    return {
      inviteId: input.inviteId,
      roleGrant: input.roleGrant,
      createdByUserId: input.createdByUserId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      usedAt: null,
      usedByUserId: null
    };
  }

  async findUserIdsByUsernamePrefix(prefix: string): Promise<string[]> {
    await this.initialize();
    const result = await this.db
      .prepare("SELECT user_id FROM accounts WHERE username LIKE ? ESCAPE '\\' COLLATE NOCASE")
      .bind(`${escapeLike(prefix.toLowerCase())}%`)
      .all<Row>();
    return (result.results ?? []).map((row) => String(row.user_id));
  }

  async deleteAccountsByUserIds(userIds: string[]): Promise<void> {
    await this.initialize();
    if (!userIds.length) return;
    const statements = [];
    for (const userId of userIds) {
      statements.push(this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId));
      statements.push(this.db.prepare("DELETE FROM accounts WHERE user_id = ?").bind(userId));
      statements.push(this.db.prepare("DELETE FROM invites WHERE used_by_user_id = ?").bind(userId));
    }
    await this.db.batch(statements);
  }
}

function mapPublicAccount(row: Row): PublicAccount {
  return {
    userId: String(row.user_id),
    username: String(row.username),
    displayName: String(row.display_name)
  };
}

function mapAccountCredentials(row: Row): AccountCredentials {
  return {
    ...mapPublicAccount(row),
    passwordHash: String(row.password_hash),
    role: asRole(row.role),
    createdAt: Number(row.created_at)
  };
}

function mapSession(row: Row): Session {
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    deviceName: String(row.device_name),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

function asRole(value: unknown): AccountRole {
  return value === "owner" || value === "admin" ? value : "member";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
