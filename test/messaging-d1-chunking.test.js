import { describe, expect, test } from "vitest";
import { D1MessagingRepository } from "../worker/src/modules/messaging/infrastructure/d1-messaging-repository.ts";
import { resetMessagingSchemaCache } from "../worker/src/modules/messaging/infrastructure/schema.ts";

// Simulates Cloudflare D1's hard limit of 100 SQL bound parameters per statement.
function createStrictD1Mock(options = {}) {
  const MAX_D1_BINDS = 100;
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) {
          if (args.length > MAX_D1_BINDS) {
            throw new Error(`D1_ERROR: too many SQL variables (${args.length} > ${MAX_D1_BINDS})`);
          }
          bound = args;
          return stmt;
        },
        async all() {
          queries.push({ sql, bindCount: bound.length, bound });
          if (typeof options.onAll === "function") {
            return { results: options.onAll(sql, bound) };
          }
          return { results: [] };
        },
        async first() {
          queries.push({ sql, bindCount: bound.length, bound });
          if (sql.includes("PRAGMA table_info")) return null;
          if (sql.includes("SELECT version FROM schema_migrations")) return { version: 9 };
          return null;
        },
        async run() {
          queries.push({ sql, bindCount: bound.length, bound });
          return { success: true, meta: { changes: 0 } };
        }
      };
      return stmt;
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
    async exec() {
      return { count: 0, duration: 0 };
    }
  };
  return db;
}

describe("D1MessagingRepository chunking under Cloudflare D1 100-variable cap", () => {
  test("listReactionsForMessages, listFavoriteIds, listMessageReaders and listMessagesByIds chunk 200+ IDs safely", async () => {
    resetMessagingSchemaCache();
    const messageIds = Array.from({ length: 205 }, (_, i) => `msg-${String(i).padStart(3, "0")}`);
    const db = createStrictD1Mock({
      onAll(sql, bound) {
        if (sql.includes("FROM message_reactions")) {
          // Return one reaction for the first ID of each chunk to verify merging.
          return [{ message_id: bound[0], emoji: "👍", user_id: "user-a" }];
        }
        if (sql.includes("FROM favorite_messages")) {
          // bound[0] is userId, bound[1..] are chunked message IDs.
          return [{ message_id: bound[1] }];
        }
        if (sql.includes("FROM message_receipts")) {
          return [{ message_id: bound[0], recipient_user_id: "user-b", read_at: 1000 }];
        }
        return [];
      }
    });

    const repo = new D1MessagingRepository(db);

    const reactions = await repo.listReactionsForMessages(messageIds, "user-a");
    expect(reactions.size).toBe(3); // 205 / 80 = 3 chunks -> 3 merged reactions
    expect(reactions.get("msg-000")?.[0]).toMatchObject({ emoji: "👍", count: 1, reactedByMe: true });
    expect(reactions.get("msg-080")?.[0]).toMatchObject({ emoji: "👍", count: 1, reactedByMe: true });
    expect(reactions.get("msg-160")?.[0]).toMatchObject({ emoji: "👍", count: 1, reactedByMe: true });

    const favorites = await repo.listFavoriteIds("user-a", messageIds);
    expect(favorites.size).toBe(3);
    expect(favorites.has("msg-000")).toBe(true);
    expect(favorites.has("msg-080")).toBe(true);
    expect(favorites.has("msg-160")).toBe(true);

    const readers = await repo.listMessageReaders("conv-1", messageIds);
    expect(readers.size).toBe(3);
    expect(readers.get("msg-160")?.[0]).toEqual({ userId: "user-b", readAt: 1000 });

    const byIds = await repo.listMessagesByIds("conv-1", messageIds, "user-a");
    expect(byIds).toBeInstanceOf(Map);

    // Every single executed SQL statement stayed strictly under Cloudflare D1's 100 bind limit.
    const maxBinds = Math.max(...db.queries.map((q) => q.bindCount));
    expect(maxBinds).toBeLessThanOrEqual(100);
  });

  test("markMessagesDelivered and markMessagesRead chunk 150 IDs without exceeding 100 SQL parameters", async () => {
    resetMessagingSchemaCache();
    const messageIds = Array.from({ length: 150 }, (_, i) => `msg-${i}`);
    const db = createStrictD1Mock({
      onAll(sql, bound) {
        if (sql.includes("FROM messages")) {
          return [{ message_id: bound[2], sender_user_id: "sender-1" }];
        }
        return [];
      }
    });

    const repo = new D1MessagingRepository(db);
    const delivered = await repo.markMessagesDelivered("conv-1", "viewer-1", messageIds, 5000);
    const read = await repo.markMessagesRead("conv-1", "viewer-1", messageIds, 6000);

    expect(delivered.length).toBe(2); // 150 / 80 = 2 chunks
    expect(read.length).toBe(2);
    const maxBinds = Math.max(...db.queries.map((q) => q.bindCount));
    expect(maxBinds).toBeLessThanOrEqual(100);
  });
});
