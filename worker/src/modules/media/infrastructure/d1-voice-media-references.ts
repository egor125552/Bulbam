import type { D1Database } from "../../../platform/cloudflare";
import type { VoiceMediaReferences } from "../ports/voice-media-references";

export class D1VoiceMediaReferences implements VoiceMediaReferences {
  constructor(private readonly db: D1Database) {}

  async listObjectKeysForUsers(userIds: string[]): Promise<string[]> {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    if (!uniqueUserIds.length) return [];

    const attachmentTable = await this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'voice_message_attachments' LIMIT 1")
      .first<{ name: string }>();
    if (!attachmentTable) return [];

    const placeholders = uniqueUserIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(`
        SELECT DISTINCT v.object_key
        FROM voice_message_attachments v
        JOIN messages m ON m.message_id = v.message_id
        JOIN direct_conversations c ON c.conversation_id = m.conversation_id
        WHERE c.participant_a_id IN (${placeholders})
           OR c.participant_b_id IN (${placeholders})
        ORDER BY v.object_key
      `)
      .bind(...uniqueUserIds, ...uniqueUserIds)
      .all<{ object_key: string }>();

    return (result.results ?? [])
      .map((row) => String(row.object_key ?? ""))
      .filter(Boolean);
  }
}
