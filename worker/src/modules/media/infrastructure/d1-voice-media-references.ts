import type { D1Database } from "../../../platform/cloudflare";
import type { VoiceMediaReferences } from "../ports/voice-media-references";

export class D1VoiceMediaReferences implements VoiceMediaReferences {
  constructor(private readonly db: D1Database) {}

  async listObjectKeysForUsers(userIds: string[]): Promise<string[]> {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    if (!uniqueUserIds.length) return [];

    const tables = await this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('voice_message_attachments', 'file_message_attachments')"
      )
      .all<{ name: string }>();
    const existingTables = new Set((tables.results ?? []).map((row) => String(row.name ?? "")));
    if (!existingTables.size) return [];

    const placeholders = uniqueUserIds.map(() => "?").join(", ");
    const keys = new Set<string>();
    for (const table of ["voice_message_attachments", "file_message_attachments"] as const) {
      if (!existingTables.has(table)) continue;
      const result = await this.db
        .prepare(`
          SELECT DISTINCT a.object_key
          FROM ${table} a
          JOIN messages m ON m.message_id = a.message_id
          JOIN conversations c ON c.conversation_id = m.conversation_id
          WHERE (c.kind='direct' AND (
              c.participant_a_id IN (${placeholders}) OR c.participant_b_id IN (${placeholders})
            )) OR (c.kind='group' AND c.owner_user_id IN (${placeholders}))
          ORDER BY a.object_key
        `)
        .bind(...uniqueUserIds, ...uniqueUserIds, ...uniqueUserIds)
        .all<{ object_key: string }>();

      for (const row of result.results ?? []) {
        const key = String(row.object_key ?? "");
        if (key) keys.add(key);
      }
    }

    return [...keys].sort();
  }
}
