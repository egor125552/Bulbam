import type { D1Database } from "../../../platform/cloudflare";

let initialization: Promise<void> | null = null;

export function ensureNotificationSchema(db: D1Database): Promise<void> {
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
    .bind("notifications")
    .all<{ version: number }>();
  const appliedVersions = new Set((applied.results ?? []).map((row) => Number(row.version)));

  if (!appliedVersions.has(1)) {
    await runStatement(
      db,
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expiration_time INTEGER,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
    await runStatement(
      db,
      "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id, updated_at)"
    );
    await db
      .prepare("INSERT OR IGNORE INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)")
      .bind("notifications", 1, Date.now())
      .run();
  }

  if (!appliedVersions.has(2)) {
    await runStatement(
      db,
      `CREATE TABLE IF NOT EXISTS push_foreground_presence (
        user_id TEXT PRIMARY KEY,
        visible_until INTEGER NOT NULL
      )`
    );
    await db
      .prepare("INSERT OR IGNORE INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)")
      .bind("notifications", 2, Date.now())
      .run();
  }
}
