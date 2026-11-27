#!/usr/bin/env node
/**
 * Bulbam Live Verification & Sandbox CLI for AI Agents.
 *
 * Works against:
 *   1. Local dev server (http://localhost:3000) using local Miniflare D1 SQLite
 *      for one-time invite creation and sandbox cleanup (zero production backdoors).
 *   2. Remote / staging Bulbam when BULBAM_SMOKE_SECRET is set (uses existing
 *      /api/v1/smoke/invite and /api/v1/smoke/cleanup routes).
 *
 * Commands:
 *   node scripts/agent-live.mjs seed     -> creates live test users + direct & group chats + sample messages, prints JSON
 *   node scripts/agent-live.mjs verify   -> runs full live E2E verification (chats, replies, reactions, favorites, forward, delete) and cleans up
 *   node scripts/agent-live.mjs cleanup  -> removes all smoke_agent_* test accounts and their data
 *
 * Options:
 *   --url=http://localhost:3000          -> target Bulbam base URL (or BULBAM_BASE_URL env)
 *   --prefix=smoke_agent_                -> username prefix for cleanup (must start with smoke_)
 *   --keep                               -> with verify, keep seeded data instead of cleaning up
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("--")) ?? "help";
const flags = Object.fromEntries(
  args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key, rest.length ? rest.join("=") : true];
    })
);

const BASE_URL = String(flags.url || process.env.BULBAM_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const SMOKE_SECRET = process.env.BULBAM_SMOKE_SECRET || "";
const PREFIX = String(flags.prefix || "smoke_agent_");
const KEEP_AFTER_VERIFY = Boolean(flags.keep);

if (!/^smoke_[a-z0-9_]+$/i.test(PREFIX)) {
  console.error("ERROR: --prefix must match /^smoke_[a-z0-9_]+$/i so real accounts are never touched.");
  process.exit(1);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomTag(len = 6) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

function findLocalD1SqlitePath() {
  const dir = path.resolve(process.cwd(), ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => {
      const full = path.join(dir, name);
      return { full, size: fs.statSync(full).size };
    })
    .sort((a, b) => b.size - a.size);
  return files[0]?.full ?? null;
}

async function ensureServerReady() {
  const response = await fetch(`${BASE_URL}/api/ready`);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Bulbam server at ${BASE_URL} is not ready (status ${response.status}). Start dev server first.`);
  }
  return data;
}

async function createInviteCode() {
  if (SMOKE_SECRET) {
    const response = await fetch(`${BASE_URL}/api/v1/smoke/invite`, {
      method: "POST",
      headers: { "x-bulbam-smoke-secret": SMOKE_SECRET }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.code) {
      throw new Error(`Smoke invite failed (${response.status}): ${JSON.stringify(data)}`);
    }
    return data.code;
  }

  const sqlitePath = findLocalD1SqlitePath();
  if (!sqlitePath) {
    throw new Error(
      "Could not find local Wrangler D1 sqlite file. Either run `npm run dev` locally or set BULBAM_SMOKE_SECRET."
    );
  }
  const code = `BLB-AGENT-${randomTag(8).toUpperCase()}-${randomTag(8).toUpperCase()}`;
  const now = Date.now();
  const db = new DatabaseSync(sqlitePath);
  try {
    db.prepare(
      `INSERT INTO invites (
        invite_id, code_hash, created_by_user_id, role_grant, created_at, expires_at, used_at, used_by_user_id
      ) VALUES (?, ?, NULL, 'member', ?, ?, NULL, NULL)`
    ).run(crypto.randomUUID(), sha256Hex(code), now, now + 30 * 60 * 1000);
  } finally {
    db.close();
  }
  return code;
}

async function cleanupPrefix(prefix = PREFIX) {
  if (SMOKE_SECRET) {
    const response = await fetch(`${BASE_URL}/api/v1/smoke/cleanup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulbam-smoke-secret": SMOKE_SECRET
      },
      body: JSON.stringify({ prefix })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(`Remote smoke cleanup failed (${response.status}): ${JSON.stringify(data)}`);
    }
    return { mode: "remote", deletedAccounts: data.deletedAccounts ?? 0 };
  }

  const sqlitePath = findLocalD1SqlitePath();
  if (!sqlitePath) {
    return { mode: "local", deletedAccounts: 0 };
  }
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db
      .prepare("SELECT user_id FROM accounts WHERE LOWER(username) LIKE LOWER(?)")
      .all(`${prefix}%`);
    const userIds = rows.map((row) => row.user_id);
    if (!userIds.length) {
      return { mode: "local", deletedAccounts: 0 };
    }
    const placeholders = userIds.map(() => "?").join(", ");
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );

    const runIfTable = (table, sql, params) => {
      if (existingTables.has(table)) {
        db.prepare(sql).run(...params);
      }
    };

    const convRows = existingTables.has("conversation_members")
      ? db
          .prepare(`SELECT DISTINCT conversation_id FROM conversation_members WHERE user_id IN (${placeholders})`)
          .all(...userIds)
      : [];
    const convIds = convRows.map((row) => row.conversation_id);
    const convPlaceholders = convIds.map(() => "?").join(", ");

    runIfTable("message_reactions", `DELETE FROM message_reactions WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("favorite_messages", `DELETE FROM favorite_messages WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("message_hidden_for_user", `DELETE FROM message_hidden_for_user WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("message_read_receipts", `DELETE FROM message_read_receipts WHERE user_id IN (${placeholders})`, userIds);

    if (convIds.length) {
      runIfTable(
        "message_reactions",
        `DELETE FROM message_reactions WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id IN (${convPlaceholders}))`,
        convIds
      );
      runIfTable(
        "favorite_messages",
        `DELETE FROM favorite_messages WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id IN (${convPlaceholders}))`,
        convIds
      );
      runIfTable(
        "message_hidden_for_user",
        `DELETE FROM message_hidden_for_user WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id IN (${convPlaceholders}))`,
        convIds
      );
      runIfTable(
        "voice_message_attachments",
        `DELETE FROM voice_message_attachments WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id IN (${convPlaceholders}))`,
        convIds
      );
      runIfTable(
        "file_message_attachments",
        `DELETE FROM file_message_attachments WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id IN (${convPlaceholders}))`,
        convIds
      );
      runIfTable("messages", `DELETE FROM messages WHERE conversation_id IN (${convPlaceholders})`, convIds);
      runIfTable("conversation_members", `DELETE FROM conversation_members WHERE conversation_id IN (${convPlaceholders})`, convIds);
      runIfTable("conversations", `DELETE FROM conversations WHERE conversation_id IN (${convPlaceholders})`, convIds);
    }

    runIfTable("sessions", `DELETE FROM sessions WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("password_recovery_codes", `DELETE FROM password_recovery_codes WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("account_passkeys", `DELETE FROM account_passkeys WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("user_presence", `DELETE FROM user_presence WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("push_subscriptions", `DELETE FROM push_subscriptions WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("accounts", `DELETE FROM accounts WHERE user_id IN (${placeholders})`, userIds);
    runIfTable("invites", "DELETE FROM invites WHERE used_by_user_id IS NOT NULL AND used_by_user_id NOT IN (SELECT user_id FROM accounts)", []);

    return { mode: "local", deletedAccounts: userIds.length };
  } finally {
    db.close();
  }
}

class AgentClient {
  constructor(name, cookie, account, credentials) {
    this.name = name;
    this.cookie = cookie;
    this.account = account;
    this.credentials = credentials;
  }

  async request(urlPath, { method = "GET", body } = {}) {
    const headers = { cookie: this.cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, data };
  }
}

async function registerAgentUser(label, displayName, tag) {
  const username = `${PREFIX}${label}_${tag}`;
  const password = `AgentPass_${randomTag(10)}!`;
  const inviteCode = await createInviteCode();
  const response = await fetch(`${BASE_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      displayName,
      password,
      inviteCode,
      deviceName: "Agent Live Harness"
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Register ${username} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  const setCookie = response.headers.get("set-cookie") || "";
  const cookiePair = setCookie.split(";")[0];
  if (!cookiePair) {
    throw new Error(`Register ${username} did not return a session cookie`);
  }
  return new AgentClient(label, cookiePair, data.account, { username, password, displayName });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function seedSandbox() {
  await ensureServerReady();
  const tag = randomTag(6);
  const alice = await registerAgentUser("alice", "Алиса Тест", tag);
  const bob = await registerAgentUser("bob", "Боб Тест", tag);
  const carol = await registerAgentUser("carol", "Катя Тест", tag);

  const directRes = await alice.request("/api/v1/chats/direct", {
    method: "POST",
    body: { userId: bob.account.userId }
  });
  assert(directRes.ok, `Open direct chat failed: ${JSON.stringify(directRes.data)}`);
  const directChatId = directRes.data.chat.conversationId;

  const groupRes = await alice.request("/api/v1/chats/groups", {
    method: "POST",
    body: {
      title: `Песочница ${tag}`,
      avatarIcon: "⭐",
      historyMode: "all",
      userIds: [bob.account.userId, carol.account.userId]
    }
  });
  assert(groupRes.ok, `Create group failed: ${JSON.stringify(groupRes.data)}`);
  const groupChatId = groupRes.data.chat.conversationId;

  const msg1Res = await alice.request(`/api/v1/chats/${directChatId}/messages`, {
    method: "POST",
    body: { clientMessageId: crypto.randomUUID(), text: "Привет, Боб! Проверяю ответы, реакции и избранное в Бульбаме." }
  });
  assert(msg1Res.ok, `Send msg1 failed: ${JSON.stringify(msg1Res.data)}`);
  const msg1 = msg1Res.data.message;

  const msg2Res = await bob.request(`/api/v1/chats/${directChatId}/messages`, {
    method: "POST",
    body: {
      clientMessageId: crypto.randomUUID(),
      text: "Привет, Алиса! Отвечаю прямо на твоё сообщение.",
      replyToMessageId: msg1.messageId
    }
  });
  assert(msg2Res.ok, `Send reply msg2 failed: ${JSON.stringify(msg2Res.data)}`);
  const msg2 = msg2Res.data.message;

  const reactRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg2.messageId}/reactions`, {
    method: "POST",
    body: { emoji: "🔥" }
  });
  assert(reactRes.ok, `Reaction failed: ${JSON.stringify(reactRes.data)}`);

  const favRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg2.messageId}/favorite`, {
    method: "POST"
  });
  assert(favRes.ok, `Favorite failed: ${JSON.stringify(favRes.data)}`);

  return {
    tag,
    baseUrl: BASE_URL,
    prefix: PREFIX,
    users: {
      alice: { ...alice.credentials, userId: alice.account.userId, cookie: alice.cookie },
      bob: { ...bob.credentials, userId: bob.account.userId, cookie: bob.cookie },
      carol: { ...carol.credentials, userId: carol.account.userId, cookie: carol.cookie }
    },
    chats: {
      directChatId,
      groupChatId
    },
    messages: {
      msg1Id: msg1.messageId,
      msg2Id: msg2.messageId
    },
    _clients: { alice, bob, carol }
  };
}

async function runLiveVerify() {
  const steps = [];
  const record = (name) => steps.push({ step: name, status: "PASS" });

  const sandbox = await seedSandbox();
  const { alice, bob, carol } = sandbox._clients;
  const { directChatId, groupChatId } = sandbox.chats;
  const { msg1Id, msg2Id } = sandbox.messages;

  try {
    record("1. Register 3 real users & create direct + group chats");

    // 2. Verify reply metadata on fetched messages
    const historyAlice = await alice.request(`/api/v1/chats/${directChatId}/messages`);
    assert(historyAlice.ok, "Fetch direct messages failed");
    const fetchedReply = historyAlice.data.messages.find((m) => m.messageId === msg2Id);
    assert(fetchedReply?.replyTo?.messageId === msg1Id, "Reply quote should reference msg1");
    assert(fetchedReply?.replyTo?.deleted === false, "Reply quote should not be deleted");
    assert(fetchedReply?.isFavorite === true, "msg2 should be marked favorite for Alice");
    assert(
      fetchedReply?.reactions?.some((r) => r.emoji === "🔥" && r.count === 1 && r.reactedByMe === true),
      "Alice should see her 🔥 reaction on msg2"
    );
    record("2. Replies, reactions, and favorite flag persist & load accurately");

    // 3. Verify Bob toggles reaction on & off, and favorites list for Alice
    const bobReactOn = await bob.request(`/api/v1/chats/${directChatId}/messages/${msg2Id}/reactions`, {
      method: "POST",
      body: { emoji: "🔥" }
    });
    assert(bobReactOn.ok && bobReactOn.data.reactions.find((r) => r.emoji === "🔥")?.count === 2, "Reaction count should be 2");
    const bobReactOff = await bob.request(`/api/v1/chats/${directChatId}/messages/${msg2Id}/reactions`, {
      method: "POST",
      body: { emoji: "🔥" }
    });
    assert(bobReactOff.ok && bobReactOff.data.reactions.find((r) => r.emoji === "🔥")?.count === 1, "Reaction toggle off should return count 1");
    record("3. Reaction toggle on/off works across multiple users");

    const favsRes = await alice.request("/api/v1/favorites");
    assert(favsRes.ok && favsRes.data.favorites.some((f) => f.messageId === msg2Id), "Favorites list should include msg2");
    const unfavRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg2Id}/favorite`, { method: "DELETE" });
    assert(unfavRes.ok, "Remove favorite failed");
    const favsAfter = await alice.request("/api/v1/favorites");
    assert(favsAfter.ok && !favsAfter.data.favorites.some((f) => f.messageId === msg2Id), "Removed favorite should disappear");
    record("4. Favorites add, list, and remove verified");

    // 4. Verify Forward from direct chat to group chat
    const forwardRes = await alice.request(`/api/v1/chats/${groupChatId}/messages/forward`, {
      method: "POST",
      body: {
        sourceConversationId: directChatId,
        sourceMessageId: msg2Id,
        clientMessageId: crypto.randomUUID()
      }
    });
    assert(forwardRes.ok, `Forward failed: ${JSON.stringify(forwardRes.data)}`);
    assert(forwardRes.data.message.forwardedFrom?.fromDisplayName === "Боб Тест", "Forwarded message must keep original author attribution");
    const carolGroupHistory = await carol.request(`/api/v1/chats/${groupChatId}/messages`);
    assert(
      carolGroupHistory.ok && carolGroupHistory.data.messages.some((m) => m.messageId === forwardRes.data.message.messageId),
      "Carol should see forwarded message in group chat"
    );
    record("5. Forward message to another chat with attribution verified");

    // 5. Verify Delete for Me hides only for requester, stays visible to peer
    const delMeRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg2Id}?scope=me`, {
      method: "DELETE"
    });
    assert(delMeRes.ok, `Delete for me failed: ${JSON.stringify(delMeRes.data)}`);
    const aliceAfterDelMe = await alice.request(`/api/v1/chats/${directChatId}/messages`);
    const bobAfterDelMe = await bob.request(`/api/v1/chats/${directChatId}/messages`);
    assert(!aliceAfterDelMe.data.messages.some((m) => m.messageId === msg2Id), "Deleted-for-me message must vanish for Alice");
    assert(bobAfterDelMe.data.messages.some((m) => m.messageId === msg2Id), "Deleted-for-me message must stay visible for Bob");
    record("6. Delete for me hides only for current user, intact for peer");

    // 6. Verify non-sender CANNOT delete for everyone (403)
    const forbiddenDel = await bob.request(`/api/v1/chats/${directChatId}/messages/${msg1Id}?scope=everyone`, {
      method: "DELETE"
    });
    assert(forbiddenDel.status === 403, `Expected 403 for non-sender delete-for-everyone, got ${forbiddenDel.status}`);
    record("7. Non-sender blocked (403) from deleting someone else's message for everyone");

    // 7. Verify sender CAN delete for everyone, and reply quote turns into "Сообщение удалено"
    const delEveryoneRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg1Id}?scope=everyone`, {
      method: "DELETE"
    });
    assert(delEveryoneRes.ok, `Delete for everyone failed: ${JSON.stringify(delEveryoneRes.data)}`);
    const bobAfterDelEveryone = await bob.request(`/api/v1/chats/${directChatId}/messages`);
    assert(!bobAfterDelEveryone.data.messages.some((m) => m.messageId === msg1Id), "Deleted-for-everyone message must vanish for Bob");
    const bobsReply = bobAfterDelEveryone.data.messages.find((m) => m.messageId === msg2Id);
    assert(bobsReply?.replyTo?.deleted === true, "Reply pointing to deleted message must degrade to deleted placeholder");
    record("8. Sender delete-for-everyone removes for all & degrades reply quote cleanly");

    let cleanupResult = null;
    if (!KEEP_AFTER_VERIFY) {
      cleanupResult = await cleanupPrefix(PREFIX);
      record(`9. Cleanup removed ${cleanupResult.deletedAccounts} sandbox accounts`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: BASE_URL,
          steps,
          cleanup: cleanupResult,
          ...(KEEP_AFTER_VERIFY
            ? {
                users: sandbox.users,
                chats: sandbox.chats
              }
            : {})
        },
        null,
        2
      )
    );
  } catch (error) {
    if (!KEEP_AFTER_VERIFY) {
      await cleanupPrefix(PREFIX).catch(() => {});
    }
    throw error;
  }
}

async function main() {
  if (command === "seed") {
    const sandbox = await seedSandbox();
    const { _clients, ...output } = sandbox;
    console.log(JSON.stringify({ ok: true, ...output }, null, 2));
    return;
  }

  if (command === "verify") {
    await runLiveVerify();
    return;
  }

  if (command === "cleanup") {
    const result = await cleanupPrefix(PREFIX);
    console.log(JSON.stringify({ ok: true, prefix: PREFIX, ...result }, null, 2));
    return;
  }

  console.log(`Bulbam Live Verification CLI for AI Agents

Usage:
  npm run agent:live -- seed       Create live sandbox accounts, direct & group chats, sample messages (outputs JSON with credentials & cookies)
  npm run agent:live -- verify     Run full live E2E verification against ${BASE_URL} and clean up
  npm run agent:live -- cleanup    Remove all ${PREFIX}* sandbox accounts and their data

Options:
  --url=http://localhost:3000      Target Bulbam server URL (or BULBAM_BASE_URL)
  --prefix=smoke_agent_            Sandbox username prefix (must start with smoke_)
  --keep                           Keep sandbox accounts after 'verify' for manual/browser inspection
`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
