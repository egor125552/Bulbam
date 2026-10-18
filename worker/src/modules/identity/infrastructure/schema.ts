import type { D1Database } from "../../../platform/cloudflare";
import { normalizeDisplayNameForSearch } from "../domain/validation";

const BOOTSTRAP_OWNER_INVITE_HASH = "f859b29b4179dbf528a6c166e615ed0cf5c2994cc9108ee4f8849af36a26354c";

const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS invites (
        invite_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT,
        role_grant TEXT NOT NULL CHECK (role_grant IN ('owner', 'admin', 'member')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        used_at INTEGER,
        used_by_user_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        invite_id TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        disabled_at INTEGER,
        FOREIGN KEY (invite_id) REFERENCES invites(invite_id)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, revoked_at, expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)",
      "CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code_hash)",
      `INSERT OR IGNORE INTO invites (
        invite_id,
        code_hash,
        created_by_user_id,
        role_grant,
        created_at,
        expires_at,
        used_at,
        used_by_user_id
      ) VALUES (
        'bootstrap-owner-v1',
        '${BOOTSTRAP_OWNER_INVITE_HASH}',
        NULL,
        'owner',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        NULL,
        NULL,
        NULL
      )`
    ]
  },
  {
    version: 2,
    statements: [
      "ALTER TABLE accounts ADD COLUMN display_name_search TEXT",
      "CREATE INDEX IF NOT EXISTS idx_accounts_display_name_search ON accounts(display_name_search)",
      "CREATE INDEX IF NOT EXISTS idx_accounts_username_search ON accounts(username)"
    ]
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS password_recovery_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_password_recovery_user ON password_recovery_codes(user_id)"
    ]
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS account_passkeys (
        credential_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '[]',
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_passkeys_user ON account_passkeys(user_id)",
      `CREATE TABLE IF NOT EXISTS passkey_challenges (
        challenge_id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('register','login')),
        user_id TEXT,
        session_id TEXT,
        requester_hash TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry ON passkey_challenges(expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_passkey_challenges_requester ON passkey_challenges(requester_hash, expires_at)"
    ]
  },
  {
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS admin_recovery_requests (
        request_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        device_name TEXT NOT NULL,
        requester_hash TEXT NOT NULL,
        verification_code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        reviewed_by TEXT,
        consumed_at INTEGER,
        consumed_nonce TEXT,
        FOREIGN KEY(user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_admin_recovery_user ON admin_recovery_requests(user_id,created_at)",
      "CREATE INDEX IF NOT EXISTS idx_admin_recovery_requester ON admin_recovery_requests(requester_hash,created_at)",
      "CREATE INDEX IF NOT EXISTS idx_admin_recovery_pending ON admin_recovery_requests(status,created_at)"
    ]
  }
] as const;

let initialization: Promise<void> | null = null;

export function ensureIdentitySchema(db: D1Database): Promise<void> {
  if (!initialization) {
    initialization = initialize(db).catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

async function runStatement(db: D1Database, sql: string): Promise<void> {
  const result = await db.prepare(sql).run();
  if (result.success === false) {
    throw new Error(result.error ?? "D1 statement failed");
  }
}

async function backfillDisplayNameSearch(db: D1Database): Promise<void> {
  const result = await db
    .prepare("SELECT user_id, display_name FROM accounts WHERE display_name_search IS NULL OR display_name_search = ''")
    .all<{ user_id: string; display_name: string }>();
  const rows = result.results ?? [];
  if (!rows.length) return;

  await db.batch(
    rows.map((row) =>
      db
        .prepare("UPDATE accounts SET display_name_search = ? WHERE user_id = ?")
        .bind(normalizeDisplayNameForSearch(String(row.display_name)), String(row.user_id))
    )
  );
}

async function initialize(db: D1Database): Promise<void> {
  await runStatement(
    db,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (module, version)
    )`
  );

  const applied = await db
    .prepare("SELECT version FROM schema_migrations WHERE module = ? ORDER BY version")
    .bind("identity")
    .all<{ version: number }>();
  const appliedVersions = new Set((applied.results ?? []).map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    for (const statement of migration.statements) {
      await runStatement(db, statement);
    }

    await db
      .prepare("INSERT OR IGNORE INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)")
      .bind("identity", migration.version, Date.now())
      .run();
  }

  await backfillDisplayNameSearch(db);
}
