import type { D1Database } from "../../../platform/cloudflare";

let initialization: Promise<void> | null = null;

export function ensureCallsSchema(db: D1Database): Promise<void> {
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
  if (result.success === false) throw new Error(result.error ?? "D1 statement failed");
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
    .bind("calls")
    .all<{ version: number }>();
  const versions = new Set((applied.results ?? []).map((row) => Number(row.version)));

  if (!versions.has(1)) {
    await runStatement(
      db,
      `CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        caller_user_id TEXT NOT NULL,
        callee_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        ended_at INTEGER,
        ended_by_user_id TEXT
      )`
    );
    await runStatement(
      db,
      "CREATE INDEX IF NOT EXISTS idx_calls_caller_status ON calls(caller_user_id, status, created_at)"
    );
    await runStatement(
      db,
      "CREATE INDEX IF NOT EXISTS idx_calls_callee_status ON calls(callee_user_id, status, created_at)"
    );
    await runStatement(
      db,
      `CREATE TABLE IF NOT EXISTS call_signals (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (call_id) REFERENCES calls(call_id) ON DELETE CASCADE
      )`
    );
    await runStatement(
      db,
      "CREATE INDEX IF NOT EXISTS idx_call_signals_call_sequence ON call_signals(call_id, sequence)"
    );
    await db
      .prepare("INSERT OR IGNORE INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)")
      .bind("calls", 1, Date.now())
      .run();
  }
}
