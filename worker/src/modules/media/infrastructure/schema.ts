import type { D1Database } from "../../../platform/cloudflare";

const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS voice_media_objects (
        session_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bitrate_bps INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('uploading', 'ready')),
        chunk_count INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS voice_media_chunks (
        session_id TEXT NOT NULL,
        part_number INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, part_number),
        FOREIGN KEY (session_id) REFERENCES voice_media_objects(session_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_voice_media_owner ON voice_media_objects(sender_user_id, conversation_id, state)",
      "CREATE INDEX IF NOT EXISTS idx_voice_media_chunks_session ON voice_media_chunks(session_id, part_number)"
    ]
  }
] as const;

let initialization: Promise<void> | null = null;

export function ensureVoiceMediaSchema(db: D1Database): Promise<void> {
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
  if (result.success === false) throw new Error(result.error ?? "D1 voice media statement failed");
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
    .bind("media")
    .all<{ version: number }>();
  const appliedVersions = new Set((applied.results ?? []).map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    for (const statement of migration.statements) await runStatement(db, statement);
    await db
      .prepare("INSERT OR IGNORE INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)")
      .bind("media", migration.version, Date.now())
      .run();
  }
}
