import type { D1Database } from "../../../platform/cloudflare";

const FILE_ATTACHMENTS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS file_message_attachments (
    message_id TEXT PRIMARY KEY,
    object_key TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'audio', 'file')),
    size_bytes INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_file_attachments_object ON file_message_attachments(object_key)"
] as const;

const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS direct_conversations (
        conversation_id TEXT PRIMARY KEY,
        participant_a_id TEXT NOT NULL,
        participant_b_id TEXT NOT NULL,
        direct_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(sender_user_id, client_message_id),
        FOREIGN KEY (conversation_id) REFERENCES direct_conversations(conversation_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_direct_conversations_a ON direct_conversations(participant_a_id, last_message_at)",
      "CREATE INDEX IF NOT EXISTS idx_direct_conversations_b ON direct_conversations(participant_b_id, last_message_at)",
      "CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_messages_sender_client ON messages(sender_user_id, client_message_id)"
    ]
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS message_receipts (
        message_id TEXT NOT NULL,
        recipient_user_id TEXT NOT NULL,
        delivered_at INTEGER,
        read_at INTEGER,
        PRIMARY KEY (message_id, recipient_user_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_message_receipts_recipient ON message_receipts(recipient_user_id, delivered_at)",
      "CREATE INDEX IF NOT EXISTS idx_message_receipts_message ON message_receipts(message_id)"
    ]
  },
  {
    version: 3,
    statements: [
      "ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'voice'))",
      `CREATE TABLE IF NOT EXISTS voice_message_attachments (
        message_id TEXT PRIMARY KEY,
        object_key TEXT NOT NULL UNIQUE,
        duration_ms INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        bitrate_bps INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS voice_listen_receipts (
        message_id TEXT NOT NULL,
        listener_user_id TEXT NOT NULL,
        listened_ms INTEGER NOT NULL DEFAULT 0,
        resume_ms INTEGER NOT NULL DEFAULT 0,
        heard_ranges TEXT NOT NULL DEFAULT '[]',
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, listener_user_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS voice_privacy_settings (
        user_id TEXT PRIMARY KEY,
        share_progress INTEGER NOT NULL DEFAULT 1 CHECK (share_progress IN (0, 1)),
        updated_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_voice_listen_listener ON voice_listen_receipts(listener_user_id, updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_voice_attachments_object ON voice_message_attachments(object_key)"
    ]
  },
  {
    version: 4,
    statements: [
      // SQLite rewrites the existing messages FK when the table is renamed.
      "ALTER TABLE direct_conversations RENAME TO conversations",
      "ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK(kind IN ('direct','group'))",
      "ALTER TABLE conversations ADD COLUMN title TEXT",
      "ALTER TABLE conversations ADD COLUMN owner_user_id TEXT",
      "ALTER TABLE conversations ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'all' CHECK(history_mode IN ('all','since_join'))",
      "ALTER TABLE conversations ADD COLUMN avatar_icon TEXT NOT NULL DEFAULT '👥'",
      `CREATE TABLE IF NOT EXISTS group_members (
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id,user_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id,conversation_id)"
    ]
  },
  {
    version: 5,
    statements: FILE_ATTACHMENTS_STATEMENTS
  },
  {
    version: 6,
    statements: FILE_ATTACHMENTS_STATEMENTS
  },
  {
    version: 7,
    statements: [
      "ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT",
      "ALTER TABLE messages ADD COLUMN forwarded_from_user_id TEXT",
      "ALTER TABLE messages ADD COLUMN forwarded_from_display_name TEXT",
      `CREATE TABLE IF NOT EXISTS message_hidden_for_user (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        hidden_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_message_hidden_user ON message_hidden_for_user(user_id, message_id)",
      `CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji),
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)",
      `CREATE TABLE IF NOT EXISTS favorite_messages (
        user_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS idx_favorite_messages_user ON favorite_messages(user_id, created_at)"
    ]
  }
] as const;

let initialization: Promise<void> | null = null;

export function ensureMessagingSchema(db: D1Database): Promise<void> {
  if (!initialization) {
    initialization = initialize(db).catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

export function resetMessagingSchemaCache(): void {
  initialization = null;
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
    .bind("messaging")
    .all<{ version: number }>();
  const appliedVersions = new Set((applied.results ?? []).map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    for (const statement of migration.statements) {
      await runMigrationStatement(db, migration.version, statement);
    }
    await db
      .prepare("INSERT OR IGNORE INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)")
      .bind("messaging", migration.version, Date.now())
      .run();
  }

  // Defensive invariants: guarantee optional tables/columns exist even after partial deploys.
  await ensureFileAttachmentsTable(db);
  await ensureMessageActionsSchema(db);
}

async function ensureMessageActionsSchema(db: D1Database): Promise<void> {
  const info = await db.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
  const columns = new Set((info.results ?? []).map((item) => String(item.name ?? "")));
  if (!columns.has("reply_to_message_id")) {
    await runStatement(db, "ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT");
  }
  if (!columns.has("forwarded_from_user_id")) {
    await runStatement(db, "ALTER TABLE messages ADD COLUMN forwarded_from_user_id TEXT");
  }
  if (!columns.has("forwarded_from_display_name")) {
    await runStatement(db, "ALTER TABLE messages ADD COLUMN forwarded_from_display_name TEXT");
  }
  for (const statement of migrations[6].statements.slice(3)) {
    await runStatement(db, statement);
  }
}

async function ensureFileAttachmentsTable(db: D1Database): Promise<void> {
  const existing = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_message_attachments'")
    .first<{ name: string }>();

  if (!existing) {
    for (const statement of FILE_ATTACHMENTS_STATEMENTS) {
      await runStatement(db, statement);
    }
    return;
  }

  const info = await db.prepare("PRAGMA table_info(file_message_attachments)").all<{ name: string }>();
  const columns = new Set((info.results ?? []).map((item) => String(item.name ?? "")));
  if (!columns.has("file_name")) {
    await runStatement(db, "ALTER TABLE file_message_attachments ADD COLUMN file_name TEXT NOT NULL DEFAULT 'file'");
  }
  if (!columns.has("mime_type")) {
    await runStatement(db, "ALTER TABLE file_message_attachments ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'");
  }
  if (!columns.has("media_kind")) {
    await runStatement(db, "ALTER TABLE file_message_attachments ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'file'");
  }
  if (!columns.has("size_bytes")) {
    await runStatement(db, "ALTER TABLE file_message_attachments ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0");
  }
  await runStatement(db, "CREATE INDEX IF NOT EXISTS idx_file_attachments_object ON file_message_attachments(object_key)");
}

// D1 migration batches are not guaranteed to be atomic. A transient Worker
// failure after the rename must allow the next request to finish v4/v7 safely.
async function runMigrationStatement(db:D1Database,version:number,sql:string):Promise<void>{
  if(version===4){
    if(sql.startsWith('ALTER TABLE direct_conversations RENAME')){
      const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
        .first<{name:string}>();
      if(exists)return;
    }
    const column=sql.match(/^ALTER TABLE conversations ADD COLUMN ([a-z_]+)/);
    if(column){
      const info=await db.prepare('PRAGMA table_info(conversations)').all<{name:string}>();
      if((info.results??[]).some(item=>item.name===column[1]))return;
    }
  }
  if (version === 7) {
    const column = sql.match(/^ALTER TABLE messages ADD COLUMN ([a-z_]+)/);
    if (column) {
      const info = await db.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
      if ((info.results ?? []).some((item) => item.name === column[1])) return;
    }
  }
  await runStatement(db,sql);
}
