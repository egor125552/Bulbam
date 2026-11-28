#!/usr/bin/env node
/**
 * Bulbam Live Control, Verification & Call Benchmark CLI for AI Agents.
 *
 * Works against:
 *   1. Local dev server (http://localhost:3000) using local Miniflare D1 SQLite
 *      for one-time invite creation and sandbox cleanup (zero production backdoors).
 *   2. Remote / staging Bulbam when BULBAM_SMOKE_SECRET is set (uses existing
 *      /api/v1/smoke/invite and /api/v1/smoke/cleanup routes).
 *
 * All commands emit machine-readable JSON to stdout (with `ok: true|false` and
 * `elapsedMs` timings) and persist created sandbox identities/chats/lastCallId
 * in `.agent-live-state.json` so follow-up commands can use short aliases
 * (`--as=alice`, `--chat=group`, `--to=bob`, `--invite=bob`).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const rawArgs = process.argv.slice(2);
const positionals = [];
const flags = {};
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  } else {
    positionals.push(arg);
  }
}

const command = positionals[0] ?? "help";
const subcommand = positionals[1] ?? "";

const STATE_PATH = path.resolve(
  process.cwd(),
  typeof flags.state === "string" ? flags.state : ".agent-live-state.json"
);
const BASE_URL = String(flags.url || process.env.BULBAM_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const SMOKE_SECRET = process.env.BULBAM_SMOKE_SECRET || "";
const PREFIX = String(flags.prefix || "smoke_agent_");
const KEEP_AFTER = Boolean(flags.keep);

if (!/^smoke_[a-z0-9_]+$/i.test(PREFIX)) {
  console.error(JSON.stringify({ ok: false, error: "--prefix must match /^smoke_[a-z0-9_]+$/i so real accounts are never touched." }));
  process.exit(1);
}

function roundMs(ms) {
  return Math.round(ms * 100) / 100;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomTag(len = 6) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function parseJsonFlag(value, fallback = undefined) {
  if (value === undefined || value === true || value === "") return fallback;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid JSON flag: ${error.message}`);
  }
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      baseUrl: BASE_URL,
      prefix: PREFIX,
      tag: null,
      users: {},
      chats: {},
      calls: { lastCallId: null, lastChatId: null }
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      baseUrl: parsed.baseUrl || BASE_URL,
      prefix: parsed.prefix || PREFIX,
      tag: parsed.tag || null,
      users: parsed.users && typeof parsed.users === "object" ? parsed.users : {},
      chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {},
      calls: parsed.calls && typeof parsed.calls === "object"
        ? parsed.calls
        : { lastCallId: null, lastChatId: null }
    };
  } catch {
    return {
      baseUrl: BASE_URL,
      prefix: PREFIX,
      tag: null,
      users: {},
      chats: {},
      calls: { lastCallId: null, lastChatId: null }
    };
  }
}

function saveState(state) {
  const payload = {
    ...state,
    baseUrl: BASE_URL,
    prefix: PREFIX,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function removeStateFile() {
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
  }
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
  const t0 = performance.now();
  const response = await fetch(`${BASE_URL}/api/ready`);
  const data = await response.json().catch(() => null);
  const readyMs = roundMs(performance.now() - t0);
  if (!response.ok || !data?.ok) {
    throw new Error(`Bulbam server at ${BASE_URL} is not ready (status ${response.status}). Start dev server first.`);
  }
  return { ...data, readyMs };
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
    runIfTable(
      "invites",
      "DELETE FROM invites WHERE used_by_user_id IS NOT NULL AND used_by_user_id NOT IN (SELECT user_id FROM accounts)",
      []
    );

    return { mode: "local", deletedAccounts: userIds.length };
  } finally {
    db.close();
  }
}

class RealtimeSocket {
  constructor(socket, connectMs) {
    this.socket = socket;
    this.connectMs = connectMs;
    this.buffer = Buffer.alloc(0);
    this.events = [];
    this.waiters = [];
    this.closed = false;
    this.fragmentOpcode = 0;
    this.fragmentChunks = [];

    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#onClose());
    socket.on("error", () => this.#onClose());
  }

  static connect(baseUrl, cookie, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const target = new URL("/api/v1/realtime", baseUrl);
      const isHttps = target.protocol === "https:";
      const key = crypto.randomBytes(16).toString("base64");
      const expectedAccept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      const t0 = performance.now();
      const transport = isHttps ? https : http;
      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": key,
          Cookie: cookie
        }
      });

      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      req.on("upgrade", (res, socket, head) => {
        clearTimeout(timer);
        if (res.headers["sec-websocket-accept"] !== expectedAccept) {
          socket.destroy();
          reject(new Error("Invalid Sec-WebSocket-Accept header"));
          return;
        }
        const ws = new RealtimeSocket(socket, roundMs(performance.now() - t0));
        if (head && head.length) {
          ws.#onData(head);
        }
        resolve(ws);
      });

      req.on("response", (res) => {
        clearTimeout(timer);
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          reject(new Error(`WebSocket upgrade rejected (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
        });
      });

      req.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      req.end();
    });
  }

  mark() {
    return this.events.length;
  }

  waitFor(predicate, { since = 0, timeoutMs = 4000, label = "event" } = {}) {
    for (let i = since; i < this.events.length; i += 1) {
      if (predicate(this.events[i].data, this.events[i])) {
        return Promise.resolve(this.events[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        resolve: (item) => {
          clearTimeout(entry.timer);
          resolve(item);
        },
        reject: (err) => {
          clearTimeout(entry.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== entry);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
        }, timeoutMs)
      };
      this.waiters.push(entry);
    });
  }

  async expectNone(predicate, { since = 0, waitMs = 350 } = {}) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const hits = this.events.slice(since).filter((item) => predicate(item.data, item));
    return { ok: hits.length === 0, hits };
  }

  sendJson(payload) {
    this.#sendFrame(0x1, Buffer.from(JSON.stringify(payload), "utf8"));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#sendFrame(0x8, Buffer.alloc(0));
    } catch {
      // ignore
    }
    this.socket.destroy();
  }

  #sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    this.socket.write(Buffer.concat([header, masked]));
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      this.buffer = this.buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x9) {
        this.#sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        continue;
      }
      if (opcode === 0x8) {
        this.close();
        return;
      }

      if (opcode !== 0x0) {
        this.fragmentOpcode = opcode;
        this.fragmentChunks = [payload];
      } else {
        this.fragmentChunks.push(payload);
      }

      if (fin && this.fragmentOpcode === 0x1) {
        const text = Buffer.concat(this.fragmentChunks).toString("utf8");
        this.fragmentChunks = [];
        this.fragmentOpcode = 0;
        let data = text;
        try {
          data = JSON.parse(text);
        } catch {
          // keep raw string
        }
        const entry = { receivedAtMs: performance.now(), data };
        this.events.push(entry);
        const remaining = [];
        for (const waiter of this.waiters) {
          if (waiter.predicate(entry.data, entry)) {
            waiter.resolve(entry);
          } else {
            remaining.push(waiter);
          }
        }
        this.waiters = remaining;
      }
    }
  }

  #onClose() {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.reject(new Error("WebSocket closed before expected event arrived"));
    }
  }
}

class AgentClient {
  constructor(name, cookie, account, credentials = {}) {
    this.name = name;
    this.cookie = cookie;
    this.account = account;
    this.credentials = credentials;
  }

  async request(urlPath, { method = "GET", body, headers: extraHeaders = {} } = {}) {
    const headers = { cookie: this.cookie, ...extraHeaders };
    if (body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    const t0 = performance.now();
    const response = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
    });
    const text = await response.text();
    const elapsedMs = roundMs(performance.now() - t0);
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, ok: response.ok, elapsedMs, data };
  }

  connectWs(timeoutMs = 5000) {
    return RealtimeSocket.connect(BASE_URL, this.cookie, timeoutMs);
  }
}

async function registerAgentUser(label, displayName, tag) {
  const safeLabel = String(label || "user").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const username = `${PREFIX}${safeLabel}_${tag}`;
  const password = `AgentPass_${randomTag(10)}!`;
  const inviteCode = await createInviteCode();
  const t0 = performance.now();
  const response = await fetch(`${BASE_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      displayName,
      password,
      inviteCode,
      deviceName: `Agent CLI (${safeLabel})`
    })
  });
  const elapsedMs = roundMs(performance.now() - t0);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Register ${username} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  const setCookie = response.headers.get("set-cookie") || "";
  const cookiePair = setCookie.split(";")[0];
  if (!cookiePair) {
    throw new Error(`Register ${username} did not return a session cookie`);
  }
  const client = new AgentClient(safeLabel, cookiePair, data.account, { username, password, displayName });
  client.registerMs = elapsedMs;
  return client;
}

function resolveUser(state, aliasOrCookie) {
  if (flags.cookie) {
    return new AgentClient("custom", String(flags.cookie), { userId: String(flags["user-id"] || "") });
  }
  const key = String(aliasOrCookie || flags.as || "alice");
  const entry = state.users[key];
  if (!entry) {
    const known = Object.keys(state.users);
    throw new Error(
      `Unknown user alias "${key}". ${known.length ? `Available: ${known.join(", ")}` : "Run 'seed' or 'user create' first."}`
    );
  }
  return new AgentClient(
    key,
    entry.cookie,
    { userId: entry.userId, username: entry.username, displayName: entry.displayName },
    { username: entry.username, password: entry.password, displayName: entry.displayName }
  );
}

function resolveUserId(state, value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (state.users[raw]?.userId) return state.users[raw].userId;
  return raw;
}

function resolveChatId(state, value) {
  const raw = String(value || flags.chat || state.calls?.lastChatId || "").trim();
  if (!raw) throw new Error("Missing --chat=<alias|conversationId>. Use 'direct', 'group', or a UUID.");
  if (state.chats[raw]) return state.chats[raw];
  if (raw === "direct" && state.chats.directChatId) return state.chats.directChatId;
  if (raw === "group" && state.chats.groupChatId) return state.chats.groupChatId;
  return raw;
}

function resolveCallId(state, value) {
  const raw = String(value || flags.call || state.calls?.lastCallId || "").trim();
  if (!raw) throw new Error("Missing --call=<callId> (and no lastCallId in state).");
  return raw;
}

async function seedSandbox({ persist = true } = {}) {
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
    body: {
      clientMessageId: crypto.randomUUID(),
      text: "Привет, Боб! Проверяю ответы, реакции и избранное в Бульбаме."
    }
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

  const users = {
    alice: { ...alice.credentials, userId: alice.account.userId, cookie: alice.cookie },
    bob: { ...bob.credentials, userId: bob.account.userId, cookie: bob.cookie },
    carol: { ...carol.credentials, userId: carol.account.userId, cookie: carol.cookie }
  };
  const chats = {
    direct: directChatId,
    group: groupChatId,
    directChatId,
    groupChatId
  };

  if (persist) {
    saveState({
      baseUrl: BASE_URL,
      prefix: PREFIX,
      tag,
      users,
      chats,
      calls: { lastCallId: null, lastChatId: null }
    });
  }

  return {
    tag,
    baseUrl: BASE_URL,
    prefix: PREFIX,
    stateFile: persist ? STATE_PATH : null,
    users,
    chats,
    messages: {
      msg1Id: msg1.messageId,
      msg2Id: msg2.messageId
    },
    _clients: { alice, bob, carol }
  };
}

function makeSyntheticSdp(type, label) {
  return [
    "v=0",
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    `s=bulbam-bench-${label}`,
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    `a=bulbam-kind:${type}`
  ].join("\r\n") + "\r\n";
}

function makeSyntheticIce(index) {
  return {
    candidate: `candidate:${index} 1 udp 2122260223 192.0.2.${10 + index} ${51000 + index} typ host generation 0`,
    sdpMid: "0",
    sdpMLineIndex: 0
  };
}

async function runCallBenchmark({ sandbox: externalSandbox = null } = {}) {
  const ownedSandbox = !externalSandbox;
  const sandbox = externalSandbox || (await seedSandbox({ persist: KEEP_AFTER }));
  const { alice, bob, carol } = sandbox._clients;
  const { directChatId, groupChatId } = sandbox.chats;

  let wsAlice = null;
  let wsBob = null;
  let wsCarol = null;

  try {
    const [aWs, bWs, cWs] = await Promise.all([
      alice.connectWs(5000),
      bob.connectWs(5000),
      carol.connectWs(5000)
    ]);
    wsAlice = aWs;
    wsBob = bWs;
    wsCarol = cWs;

    const iceRes = await alice.request("/api/v1/calls/ice");
    assert(iceRes.ok && Array.isArray(iceRes.data?.iceServers), `ICE fetch failed: ${JSON.stringify(iceRes.data)}`);

    const directRoot = `/api/v1/chats/${directChatId}/calls`;
    const bobMark1 = wsBob.mark();
    const directStartT0 = performance.now();
    const startDirectRes = await alice.request(directRoot, { method: "POST" });
    assert(startDirectRes.ok, `Direct call start failed: ${JSON.stringify(startDirectRes.data)}`);
    const directCallId = startDirectRes.data.call.callId;
    const directCallRoot = `${directRoot}/${directCallId}`;

    const bobRingEvt = await wsBob.waitFor(
      (evt) => evt?.type === "call.ringing" && evt?.call?.callId === directCallId,
      { since: bobMark1, timeoutMs: 4000, label: "direct call.ringing on Bob WS" }
    );
    const directRingDeliveryWsMs = roundMs(bobRingEvt.receivedAtMs - directStartT0);

    const preOfferRes = await alice.request(`${directCallRoot}/signals`, {
      method: "POST",
      body: {
        kind: "offer",
        payload: { type: "offer", sdp: makeSyntheticSdp("offer", "direct-preoffer") }
      }
    });
    assert(preOfferRes.ok, `Direct pre-offer failed: ${JSON.stringify(preOfferRes.data)}`);

    const aliceAnsMark = wsAlice.mark();
    const answerT0 = performance.now();
    const answerDirectRes = await bob.request(`${directCallRoot}/answer`, { method: "POST" });
    assert(answerDirectRes.ok, `Direct answer failed: ${JSON.stringify(answerDirectRes.data)}`);
    const aliceAnsweredEvt = await wsAlice.waitFor(
      (evt) => evt?.type === "call.answered" && evt?.callId === directCallId,
      { since: aliceAnsMark, timeoutMs: 4000, label: "direct call.answered on Alice WS" }
    );
    const directAnswerDeliveryWsMs = roundMs(aliceAnsweredEvt.receivedAtMs - answerT0);

    const pullPreOfferRes = await bob.request(`${directCallRoot}/signals?after=0`);
    assert(
      pullPreOfferRes.ok &&
        pullPreOfferRes.data?.signals?.some((s) => s.kind === "offer" && s.senderUserId === alice.account.userId),
      `Bob did not receive buffered pre-offer after answer: ${JSON.stringify(pullPreOfferRes.data)}`
    );

    const aliceSdpAnsMark = wsAlice.mark();
    const sdpAnsT0 = performance.now();
    const sdpAnsRes = await bob.request(`${directCallRoot}/signals`, {
      method: "POST",
      body: {
        kind: "answer",
        payload: { type: "answer", sdp: makeSyntheticSdp("answer", "direct-answer") }
      }
    });
    assert(sdpAnsRes.ok, `Direct SDP answer failed: ${JSON.stringify(sdpAnsRes.data)}`);
    const aliceSdpAnsEvt = await wsAlice.waitFor(
      (evt) => evt?.type === "call.signal" && evt?.callId === directCallId && evt?.signal?.kind === "answer",
      { since: aliceSdpAnsMark, timeoutMs: 4000, label: "direct SDP answer WS delivery" }
    );
    const directSdpAnswerWsMs = roundMs(aliceSdpAnsEvt.receivedAtMs - sdpAnsT0);

    const bobIceMark = wsBob.mark();
    const iceBatchT0 = performance.now();
    const iceBatchRes = await alice.request(`${directCallRoot}/signals`, {
      method: "POST",
      body: {
        signals: [
          { kind: "ice", payload: makeSyntheticIce(1) },
          { kind: "ice", payload: makeSyntheticIce(2) },
          { kind: "ice", payload: makeSyntheticIce(3) }
        ]
      }
    });
    assert(iceBatchRes.ok, `Direct ICE batch failed: ${JSON.stringify(iceBatchRes.data)}`);
    const bobIceEvt = await wsBob.waitFor(
      (evt) => evt?.type === "call.signals" && evt?.callId === directCallId && Array.isArray(evt?.signals) && evt.signals.length === 3,
      { since: bobIceMark, timeoutMs: 4000, label: "direct ICE batch WS delivery" }
    );
    const directIceBatchWsMs = roundMs(bobIceEvt.receivedAtMs - iceBatchT0);
    const directTotalSignalingSetupMs = roundMs(bobIceEvt.receivedAtMs - directStartT0);

    const bobEndMark = wsBob.mark();
    const endDirectT0 = performance.now();
    const endDirectRes = await alice.request(`${directCallRoot}/end`, { method: "POST" });
    assert(endDirectRes.ok, `Direct end failed: ${JSON.stringify(endDirectRes.data)}`);
    const bobEndEvt = await wsBob.waitFor(
      (evt) => evt?.type === "call.ended" && evt?.callId === directCallId,
      { since: bobEndMark, timeoutMs: 4000, label: "direct call.ended on Bob WS" }
    );
    const directEndDeliveryWsMs = roundMs(bobEndEvt.receivedAtMs - endDirectT0);

    const groupRoot = `/api/v1/chats/${groupChatId}/calls`;
    const bobGroupRingMark = wsBob.mark();
    const carolGroupRingMark = wsCarol.mark();
    const groupStartT0 = performance.now();

    const startGroupRes = await alice.request(groupRoot, {
      method: "POST",
      body: { invitedUserIds: [bob.account.userId] }
    });
    assert(startGroupRes.ok, `Group call start failed: ${JSON.stringify(startGroupRes.data)}`);
    const groupCall = startGroupRes.data.call;
    const groupCallId = groupCall.callId;
    const groupCallRoot = `${groupRoot}/${groupCallId}`;
    assert(
      Array.isArray(groupCall.invitedUserIds) &&
        groupCall.invitedUserIds.length === 1 &&
        groupCall.invitedUserIds[0] === bob.account.userId,
      `Expected invitedUserIds=[bob], got ${JSON.stringify(groupCall.invitedUserIds)}`
    );

    const bobGroupRingEvt = await wsBob.waitFor(
      (evt) => evt?.type === "call.ringing" && evt?.call?.callId === groupCallId,
      { since: bobGroupRingMark, timeoutMs: 4000, label: "selective group call.ringing on Bob WS" }
    );
    const groupSelectiveRingWsMs = roundMs(bobGroupRingEvt.receivedAtMs - groupStartT0);

    const carolNoRing = await wsCarol.expectNone(
      (evt) => evt?.type === "call.ringing" && evt?.call?.callId === groupCallId,
      { since: carolGroupRingMark, waitMs: 350 }
    );
    assert(carolNoRing.ok, `Selective invite leak! Carol unexpectedly received call.ringing: ${JSON.stringify(carolNoRing.hits)}`);

    const aliceBobJoinMark = wsAlice.mark();
    const bobJoinT0 = performance.now();
    const bobJoinRes = await bob.request(`${groupCallRoot}/join`, { method: "POST" });
    assert(bobJoinRes.ok, `Bob group join failed: ${JSON.stringify(bobJoinRes.data)}`);
    const aliceBobJoinedEvt = await wsAlice.waitFor(
      (evt) => evt?.type === "call.participant.joined" && evt?.callId === groupCallId && evt?.participant?.userId === bob.account.userId,
      { since: aliceBobJoinMark, timeoutMs: 4000, label: "Bob joined WS on Alice" }
    );
    const groupBobJoinWsMs = roundMs(aliceBobJoinedEvt.receivedAtMs - bobJoinT0);

    const aliceCarolJoinMark = wsAlice.mark();
    const bobCarolJoinMark = wsBob.mark();
    const carolJoinT0 = performance.now();
    const carolJoinRes = await carol.request(`${groupCallRoot}/join`, { method: "POST" });
    assert(carolJoinRes.ok, `Carol group join failed: ${JSON.stringify(carolJoinRes.data)}`);
    const [aliceCarolEvt, bobCarolEvt] = await Promise.all([
      wsAlice.waitFor(
        (evt) => evt?.type === "call.participant.joined" && evt?.callId === groupCallId && evt?.participant?.userId === carol.account.userId,
        { since: aliceCarolJoinMark, timeoutMs: 4000, label: "Carol joined WS on Alice" }
      ),
      wsBob.waitFor(
        (evt) => evt?.type === "call.participant.joined" && evt?.callId === groupCallId && evt?.participant?.userId === carol.account.userId,
        { since: bobCarolJoinMark, timeoutMs: 4000, label: "Carol joined WS on Bob" }
      )
    ]);
    const groupCarolJoinWsMs = roundMs(Math.max(aliceCarolEvt.receivedAtMs, bobCarolEvt.receivedAtMs) - carolJoinT0);

    const bobMeshMark = wsBob.mark();
    const carolMeshMark = wsCarol.mark();
    const meshOfferT0 = performance.now();
    const meshOfferRes = await alice.request(`${groupCallRoot}/signals`, {
      method: "POST",
      body: {
        kind: "offer",
        targetUserId: bob.account.userId,
        payload: { type: "offer", sdp: makeSyntheticSdp("offer", "group-alice-to-bob") }
      }
    });
    assert(meshOfferRes.ok, `Group targeted offer failed: ${JSON.stringify(meshOfferRes.data)}`);
    const bobMeshEvt = await wsBob.waitFor(
      (evt) => evt?.type === "call.signal" && evt?.callId === groupCallId && evt?.signal?.targetUserId === bob.account.userId,
      { since: bobMeshMark, timeoutMs: 4000, label: "targeted mesh offer on Bob WS" }
    );
    const groupTargetedOfferWsMs = roundMs(bobMeshEvt.receivedAtMs - meshOfferT0);
    const carolNoMeshLeak = await wsCarol.expectNone(
      (evt) => evt?.type === "call.signal" && evt?.callId === groupCallId && evt?.signal?.targetUserId === bob.account.userId,
      { since: carolMeshMark, waitMs: 250 }
    );
    assert(carolNoMeshLeak.ok, "Targeted mesh signal leaked to Carol!");

    const aliceMuteMark = wsAlice.mark();
    const carolMuteMark = wsCarol.mark();
    const muteT0 = performance.now();
    const muteRes = await bob.request(`${groupCallRoot}/mute`, {
      method: "POST",
      body: { muted: true }
    });
    assert(muteRes.ok, `Group mute failed: ${JSON.stringify(muteRes.data)}`);
    const [aliceMuteEvt, carolMuteEvt] = await Promise.all([
      wsAlice.waitFor(
        (evt) => evt?.type === "call.participant.updated" && evt?.callId === groupCallId && evt?.participant?.userId === bob.account.userId,
        { since: aliceMuteMark, timeoutMs: 4000, label: "mute sync on Alice WS" }
      ),
      wsCarol.waitFor(
        (evt) => evt?.type === "call.participant.updated" && evt?.callId === groupCallId && evt?.participant?.userId === bob.account.userId,
        { since: carolMuteMark, timeoutMs: 4000, label: "mute sync on Carol WS" }
      )
    ]);
    const groupMuteSyncWsMs = roundMs(Math.max(aliceMuteEvt.receivedAtMs, carolMuteEvt.receivedAtMs) - muteT0);

    const aliceLeaveMark = wsAlice.mark();
    const leaveT0 = performance.now();
    const leaveRes = await bob.request(`${groupCallRoot}/leave`, { method: "POST", body: {} });
    assert(leaveRes.ok, `Bob leave failed: ${JSON.stringify(leaveRes.data)}`);
    const aliceLeaveEvt = await wsAlice.waitFor(
      (evt) => evt?.type === "call.participant.left" && evt?.callId === groupCallId && evt?.userId === bob.account.userId,
      { since: aliceLeaveMark, timeoutMs: 4000, label: "Bob left WS on Alice" }
    );
    const groupLeaveWsMs = roundMs(aliceLeaveEvt.receivedAtMs - leaveT0);

    const carolEndMark = wsCarol.mark();
    const endAllT0 = performance.now();
    const endAllRes = await alice.request(`${groupCallRoot}/end`, {
      method: "POST",
      body: { endForAll: true }
    });
    assert(endAllRes.ok, `Group endForAll failed: ${JSON.stringify(endAllRes.data)}`);
    const carolEndEvt = await wsCarol.waitFor(
      (evt) => evt?.type === "call.ended" && evt?.callId === groupCallId,
      { since: carolEndMark, timeoutMs: 4000, label: "group call.ended on Carol WS" }
    );
    const groupEndForAllWsMs = roundMs(carolEndEvt.receivedAtMs - endAllT0);

    const report = {
      wsConnectMs: {
        alice: wsAlice.connectMs,
        bob: wsBob.connectMs,
        carol: wsCarol.connectMs
      },
      iceConfig: {
        fetchMs: iceRes.elapsedMs,
        iceServerCount: iceRes.data.iceServers.length
      },
      directCall: {
        callId: directCallId,
        startHttpMs: startDirectRes.elapsedMs,
        ringDeliveryWsMs: directRingDeliveryWsMs,
        preOfferUploadHttpMs: preOfferRes.elapsedMs,
        answerHttpMs: answerDirectRes.elapsedMs,
        answerDeliveryWsMs: directAnswerDeliveryWsMs,
        preOfferPullAfterAnswerHttpMs: pullPreOfferRes.elapsedMs,
        sdpAnswerHttpMs: sdpAnsRes.elapsedMs,
        sdpAnswerDeliveryWsMs: directSdpAnswerWsMs,
        iceBatch3HttpMs: iceBatchRes.elapsedMs,
        iceBatch3DeliveryWsMs: directIceBatchWsMs,
        totalSignalingSetupMs: directTotalSignalingSetupMs,
        endHttpMs: endDirectRes.elapsedMs,
        endDeliveryWsMs: directEndDeliveryWsMs
      },
      groupCall: {
        callId: groupCallId,
        startHttpMs: startGroupRes.elapsedMs,
        selectiveRingToBobWsMs: groupSelectiveRingWsMs,
        selectiveInviteIsolated: true,
        bobJoinHttpMs: bobJoinRes.elapsedMs,
        bobJoinDeliveryWsMs: groupBobJoinWsMs,
        carolJoinHttpMs: carolJoinRes.elapsedMs,
        carolJoinFanoutWsMs: groupCarolJoinWsMs,
        targetedOfferHttpMs: meshOfferRes.elapsedMs,
        targetedOfferDeliveryWsMs: groupTargetedOfferWsMs,
        targetedMeshIsolated: true,
        muteHttpMs: muteRes.elapsedMs,
        muteFanoutWsMs: groupMuteSyncWsMs,
        leaveHttpMs: leaveRes.elapsedMs,
        leaveDeliveryWsMs: groupLeaveWsMs,
        endForAllHttpMs: endAllRes.elapsedMs,
        endForAllDeliveryWsMs: groupEndForAllWsMs
      }
    };

    let cleanupResult = null;
    if (ownedSandbox && !KEEP_AFTER) {
      cleanupResult = await cleanupPrefix(PREFIX);
    }

    return { report, cleanup: cleanupResult };
  } finally {
    wsAlice?.close();
    wsBob?.close();
    wsCarol?.close();
    if (ownedSandbox && !KEEP_AFTER) {
      await cleanupPrefix(PREFIX).catch(() => {});
    }
  }
}

async function runLiveVerify() {
  const steps = [];
  const record = (name) => steps.push({ step: name, status: "PASS" });

  const sandbox = await seedSandbox({ persist: KEEP_AFTER });
  const { alice, bob, carol } = sandbox._clients;
  const { directChatId, groupChatId } = sandbox.chats;
  const { msg1Id, msg2Id } = sandbox.messages;

  try {
    record("1. Register 3 real users & create direct + group chats");

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

    const forbiddenEdit = await bob.request(`/api/v1/chats/${directChatId}/messages/${msg1Id}`, {
      method: "PATCH",
      body: { text: "Боб пытается подделать сообщение" }
    });
    assert(forbiddenEdit.status === 403, `Expected 403 for non-sender edit, got ${forbiddenEdit.status}`);

    const editedText = "Привет от Алисы — отредактировано https://bulbam.app/test";
    const editRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg1Id}`, {
      method: "PATCH",
      body: { text: editedText }
    });
    assert(editRes.ok, `Sender edit failed: ${JSON.stringify(editRes.data)}`);
    assert(editRes.data.message?.text === editedText, "Edited message text mismatch");
    assert(typeof editRes.data.message?.editedAt === "number", "Edited message must include editedAt");

    const bobAfterEdit = await bob.request(`/api/v1/chats/${directChatId}/messages`);
    const editedForBob = bobAfterEdit.data.messages.find((m) => m.messageId === msg1Id);
    const replyAfterEdit = bobAfterEdit.data.messages.find((m) => m.messageId === msg2Id);
    assert(editedForBob?.text === editedText && typeof editedForBob?.editedAt === "number", "Peer must see edited text and editedAt");
    assert(replyAfterEdit?.replyTo?.text === editedText, "Reply quote must reflect edited original text");
    record("2b. Message editing (sender PATCH, editedAt, reply quote sync, non-sender 403) verified");

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

    const delMeRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg2Id}?scope=me`, {
      method: "DELETE"
    });
    assert(delMeRes.ok, `Delete for me failed: ${JSON.stringify(delMeRes.data)}`);
    const aliceAfterDelMe = await alice.request(`/api/v1/chats/${directChatId}/messages`);
    const bobAfterDelMe = await bob.request(`/api/v1/chats/${directChatId}/messages`);
    assert(!aliceAfterDelMe.data.messages.some((m) => m.messageId === msg2Id), "Deleted-for-me message must vanish for Alice");
    assert(bobAfterDelMe.data.messages.some((m) => m.messageId === msg2Id), "Deleted-for-me message must stay visible for Bob");
    record("6. Delete for me hides only for current user, intact for peer");

    const forbiddenDel = await bob.request(`/api/v1/chats/${directChatId}/messages/${msg1Id}?scope=everyone`, {
      method: "DELETE"
    });
    assert(forbiddenDel.status === 403, `Expected 403 for non-sender delete-for-everyone, got ${forbiddenDel.status}`);
    record("7. Non-sender blocked (403) from deleting someone else's message for everyone");

    const delEveryoneRes = await alice.request(`/api/v1/chats/${directChatId}/messages/${msg1Id}?scope=everyone`, {
      method: "DELETE"
    });
    assert(delEveryoneRes.ok, `Delete for everyone failed: ${JSON.stringify(delEveryoneRes.data)}`);
    const bobAfterDelEveryone = await bob.request(`/api/v1/chats/${directChatId}/messages`);
    assert(!bobAfterDelEveryone.data.messages.some((m) => m.messageId === msg1Id), "Deleted-for-everyone message must vanish for Bob");
    const bobsReply = bobAfterDelEveryone.data.messages.find((m) => m.messageId === msg2Id);
    assert(bobsReply?.replyTo?.deleted === true, "Reply pointing to deleted message must degrade to deleted placeholder");
    record("8. Sender delete-for-everyone removes for all & degrades reply quote cleanly");

    const { report: callBenchmark } = await runCallBenchmark({ sandbox });
    record("9. Live 1-on-1 & 3-party selective group call WebSocket signaling benchmark passed");

    let cleanupResult = null;
    if (!KEEP_AFTER) {
      cleanupResult = await cleanupPrefix(PREFIX);
      record(`10. Cleanup removed ${cleanupResult.deletedAccounts} sandbox accounts`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: BASE_URL,
          steps,
          callBenchmark,
          cleanup: cleanupResult,
          ...(KEEP_AFTER
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
    if (!KEEP_AFTER) {
      await cleanupPrefix(PREFIX).catch(() => {});
    }
    throw error;
  }
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function printHelp() {
  console.log(`Bulbam Full Live Control & Call Telemetry CLI for AI Agents

Core Lifecycle:
  npm run agent:live -- seed                          Create 3 live sandbox users (alice/bob/carol) + direct & group chats, save state
  npm run agent:live -- status                        Check live server readiness + show saved users/chats/lastCallId
  npm run agent:live -- bench-calls [--rounds=1]      Run live HTTP + WebSocket speed benchmark (1-on-1 + selective 3-party group call)
  npm run agent:live -- verify [--keep]               Run full E2E messaging + live call benchmark verification
  npm run agent:live -- cleanup                       Delete all ${PREFIX}* sandbox accounts and local state file

Users:
  npm run agent:live -- user create --label=dave [--name="Давид"]
  npm run agent:live -- user login --username=<u> --password=<p> [--label=custom]

Chats:
  npm run agent:live -- chat list --as=alice
  npm run agent:live -- chat direct --as=alice --with=bob [--alias=direct2]
  npm run agent:live -- chat group --as=alice --title="Тест" --members=bob,carol [--alias=group2]
  npm run agent:live -- chat members --as=alice --chat=group

Messages:
  npm run agent:live -- msg send --as=alice --chat=direct --text="Привет" [--reply=<msgId>]
  npm run agent:live -- msg edit --as=alice --chat=direct --msg=<msgId> --text="Новый текст"
  npm run agent:live -- msg list --as=alice --chat=direct [--limit=30]
  npm run agent:live -- msg react --as=alice --chat=direct --msg=<msgId> --emoji="🔥"
  npm run agent:live -- msg forward --as=alice --from-chat=direct --msg=<msgId> --to-chat=group
  npm run agent:live -- msg star --as=alice --chat=direct --msg=<msgId> [--off]
  npm run agent:live -- msg delete --as=alice --chat=direct --msg=<msgId> [--scope=me|everyone]

Calls (1-on-1 & Selective Group Calls):
  npm run agent:live -- call ice --as=alice
  npm run agent:live -- call start --as=alice --chat=group [--invite=bob,carol]
  npm run agent:live -- call active --as=bob --chat=group
  npm run agent:live -- call answer --as=bob [--chat=direct] [--call=<callId>]
  npm run agent:live -- call join --as=bob [--chat=group] [--call=<callId>]
  npm run agent:live -- call mute --as=bob [--chat=group] [--call=<callId>] --muted=true|false
  npm run agent:live -- call signal --as=alice --kind=offer|answer|ice [--to=bob] [--sdp="..."] [--payload='{...}']
  npm run agent:live -- call signals --as=bob [--after=0]
  npm run agent:live -- call leave --as=bob [--all]
  npm run agent:live -- call end --as=alice [--all]

Realtime WebSocket & Universal Raw API:
  npm run agent:live -- ws listen --as=bob [--duration=5000] [--max=10] [--event=call.ringing]
  npm run agent:live -- api --as=alice --method=GET --path=/api/v1/chats [--body='{}']

Global Flags:
  --url=http://localhost:3000      Target Bulbam base URL (or BULBAM_BASE_URL)
  --prefix=smoke_agent_            Sandbox username prefix (must start with smoke_)
  --state=.agent-live-state.json   Custom state file path
  --keep                           Keep sandbox accounts after verify / bench-calls
`);
}

async function main() {
  if (command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "seed") {
    const sandbox = await seedSandbox({ persist: true });
    const { _clients, ...output } = sandbox;
    printJson({ ok: true, ...output });
    return;
  }

  if (command === "status") {
    const ready = await ensureServerReady();
    const state = loadState();
    printJson({
      ok: true,
      server: ready,
      stateFile: fs.existsSync(STATE_PATH) ? STATE_PATH : null,
      users: Object.fromEntries(
        Object.entries(state.users).map(([alias, u]) => [
          alias,
          { userId: u.userId, username: u.username, displayName: u.displayName }
        ])
      ),
      chats: state.chats,
      calls: state.calls
    });
    return;
  }

  if (command === "verify") {
    await runLiveVerify();
    return;
  }

  if (command === "bench-calls") {
    const rounds = Math.max(1, Math.min(10, Number(flags.rounds || 1)));
    const results = [];
    for (let i = 0; i < rounds; i += 1) {
      const { report, cleanup } = await runCallBenchmark();
      results.push({ round: i + 1, ...report, cleanup });
    }
    printJson({
      ok: true,
      baseUrl: BASE_URL,
      rounds,
      ...(rounds === 1 ? { benchmark: results[0] } : { benchmarks: results })
    });
    return;
  }

  if (command === "cleanup") {
    const result = await cleanupPrefix(PREFIX);
    removeStateFile();
    printJson({ ok: true, prefix: PREFIX, stateRemoved: true, ...result });
    return;
  }

  if (command === "user") {
    const state = loadState();
    if (subcommand === "create") {
      await ensureServerReady();
      const label = String(flags.label || `user${Object.keys(state.users).length + 1}`);
      const displayName = String(flags.name || `Агент ${label}`);
      const tag = state.tag || randomTag(6);
      const client = await registerAgentUser(label, displayName, tag);
      state.tag = tag;
      state.users[client.name] = {
        ...client.credentials,
        userId: client.account.userId,
        cookie: client.cookie
      };
      saveState(state);
      printJson({
        ok: true,
        elapsedMs: client.registerMs,
        alias: client.name,
        user: state.users[client.name]
      });
      return;
    }

    if (subcommand === "login") {
      const username = String(flags.username || "").trim();
      const password = String(flags.password || "");
      assert(username && password, "user login requires --username and --password");
      const t0 = performance.now();
      const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, deviceName: "Agent CLI" })
      });
      const elapsedMs = roundMs(performance.now() - t0);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new Error(`Login failed (${response.status}): ${JSON.stringify(data)}`);
      }
      const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
      assert(cookie, "Login response did not include session cookie");
      const alias = String(flags.label || username);
      state.users[alias] = {
        username: data.account.username,
        displayName: data.account.displayName,
        password,
        userId: data.account.userId,
        cookie
      };
      saveState(state);
      printJson({ ok: true, elapsedMs, alias, user: state.users[alias] });
      return;
    }
    throw new Error(`Unknown user subcommand "${subcommand}". Use create or login.`);
  }

  if (command === "chat") {
    const state = loadState();
    const actor = resolveUser(state);

    if (subcommand === "list") {
      const res = await actor.request("/api/v1/chats");
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "direct") {
      const peerId = resolveUserId(state, flags.with || flags.to);
      assert(peerId, "chat direct requires --with=<alias|userId>");
      const res = await actor.request("/api/v1/chats/direct", {
        method: "POST",
        body: { userId: peerId }
      });
      if (res.ok && res.data?.chat?.conversationId) {
        const alias = String(flags.alias || "direct");
        state.chats[alias] = res.data.chat.conversationId;
        saveState(state);
      }
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "group") {
      const title = String(flags.title || `Группа ${randomTag(4)}`);
      const membersRaw = String(flags.members || "");
      const userIds = membersRaw
        .split(",")
        .map((item) => resolveUserId(state, item))
        .filter(Boolean);
      const res = await actor.request("/api/v1/chats/groups", {
        method: "POST",
        body: {
          title,
          avatarIcon: String(flags.icon || "⭐"),
          historyMode: String(flags.history || "all"),
          userIds
        }
      });
      if (res.ok && res.data?.chat?.conversationId) {
        const alias = String(flags.alias || "group");
        state.chats[alias] = res.data.chat.conversationId;
        saveState(state);
      }
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "members") {
      const chatId = resolveChatId(state);
      const res = await actor.request(`/api/v1/chats/${chatId}/members`);
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    throw new Error(`Unknown chat subcommand "${subcommand}". Use list, direct, group, or members.`);
  }

  if (command === "msg") {
    const state = loadState();
    const actor = resolveUser(state);

    if (subcommand === "send") {
      const chatId = resolveChatId(state);
      const text = String(flags.text || "");
      assert(text.length > 0, "msg send requires --text=\"...\"");
      const body = {
        clientMessageId: String(flags["client-id"] || crypto.randomUUID()),
        text
      };
      if (flags.reply) body.replyToMessageId = String(flags.reply);
      const res = await actor.request(`/api/v1/chats/${chatId}/messages`, { method: "POST", body });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "edit") {
      const chatId = resolveChatId(state);
      const msgId = String(flags.msg || "");
      const text = String(flags.text || "");
      assert(msgId && text.length > 0, "msg edit requires --msg=<messageId> and --text=\"...\"");
      const res = await actor.request(`/api/v1/chats/${chatId}/messages/${msgId}`, {
        method: "PATCH",
        body: { text }
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "list") {
      const chatId = resolveChatId(state);
      const limit = Number(flags.limit || 30);
      const res = await actor.request(`/api/v1/chats/${chatId}/messages?limit=${limit}`);
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "react") {
      const chatId = resolveChatId(state);
      const msgId = String(flags.msg || "");
      const emoji = String(flags.emoji || "👍");
      assert(msgId, "msg react requires --msg=<messageId>");
      const res = await actor.request(`/api/v1/chats/${chatId}/messages/${msgId}/reactions`, {
        method: "POST",
        body: { emoji }
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "forward") {
      const fromChatId = resolveChatId(state, flags["from-chat"]);
      const toChatId = resolveChatId(state, flags["to-chat"]);
      const msgId = String(flags.msg || "");
      assert(msgId, "msg forward requires --from-chat, --to-chat, and --msg");
      const res = await actor.request(`/api/v1/chats/${toChatId}/messages/forward`, {
        method: "POST",
        body: {
          sourceConversationId: fromChatId,
          sourceMessageId: msgId,
          clientMessageId: crypto.randomUUID()
        }
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "star") {
      const chatId = resolveChatId(state);
      const msgId = String(flags.msg || "");
      assert(msgId, "msg star requires --msg=<messageId>");
      const method = flags.off ? "DELETE" : "POST";
      const res = await actor.request(`/api/v1/chats/${chatId}/messages/${msgId}/favorite`, { method });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "delete") {
      const chatId = resolveChatId(state);
      const msgId = String(flags.msg || "");
      const scope = String(flags.scope || "me");
      assert(msgId, "msg delete requires --msg=<messageId>");
      const res = await actor.request(`/api/v1/chats/${chatId}/messages/${msgId}?scope=${encodeURIComponent(scope)}`, {
        method: "DELETE"
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    throw new Error(`Unknown msg subcommand "${subcommand}". Use send, list, react, forward, star, or delete.`);
  }

  if (command === "call") {
    const state = loadState();
    const actor = resolveUser(state);

    if (subcommand === "ice") {
      const res = await actor.request("/api/v1/calls/ice");
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "start") {
      const chatId = resolveChatId(state);
      const body = {};
      if (flags.invite) {
        body.invitedUserIds = String(flags.invite)
          .split(",")
          .map((item) => resolveUserId(state, item))
          .filter(Boolean);
      }
      const res = await actor.request(`/api/v1/chats/${chatId}/calls`, {
        method: "POST",
        ...(Object.keys(body).length ? { body } : {})
      });
      if (res.ok && res.data?.call?.callId) {
        state.calls = { lastCallId: res.data.call.callId, lastChatId: chatId };
        saveState(state);
      }
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "active") {
      const chatId = resolveChatId(state);
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/active`);
      if (res.ok && res.data?.call?.callId) {
        state.calls = { lastCallId: res.data.call.callId, lastChatId: chatId };
        saveState(state);
      }
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "answer") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/answer`, { method: "POST" });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "join") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/join`, { method: "POST" });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "mute") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      const muted = String(flags.muted ?? "true") !== "false";
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/mute`, {
        method: "POST",
        body: { muted }
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "signal") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      let body = parseJsonFlag(flags.payload);
      if (!body) {
        const kind = String(flags.kind || "offer");
        const targetUserId = resolveUserId(state, flags.to);
        let payload;
        if (kind === "ice") {
          payload = {
            candidate: String(flags.candidate || makeSyntheticIce(1).candidate),
            sdpMid: "0",
            sdpMLineIndex: 0
          };
        } else {
          payload = { type: kind, sdp: String(flags.sdp || makeSyntheticSdp(kind, actor.name)) };
        }
        body = { kind, ...(targetUserId ? { targetUserId } : {}), payload };
      }
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/signals`, {
        method: "POST",
        body
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "signals") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      const after = Number(flags.after || 0);
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/signals?after=${after}`);
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "leave") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/leave`, {
        method: "POST",
        body: { endForAll: Boolean(flags.all) }
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    if (subcommand === "end") {
      const chatId = resolveChatId(state);
      const callId = resolveCallId(state);
      const res = await actor.request(`/api/v1/chats/${chatId}/calls/${callId}/end`, {
        method: "POST",
        body: { endForAll: Boolean(flags.all) }
      });
      printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, ...res.data });
      return;
    }

    throw new Error(`Unknown call subcommand "${subcommand}".`);
  }

  if (command === "ws") {
    const state = loadState();
    const actor = resolveUser(state);
    if (subcommand !== "listen") {
      throw new Error(`Unknown ws subcommand "${subcommand}". Use: ws listen --as=bob [--duration=5000]`);
    }
    const durationMs = Math.max(200, Math.min(60_000, Number(flags.duration || 5000)));
    const maxEvents = Math.max(1, Math.min(500, Number(flags.max || 50)));
    const eventFilter = typeof flags.event === "string" ? flags.event : null;

    const ws = await actor.connectWs(5000);
    const startT0 = performance.now();
    const collected = [];
    try {
      const deadline = Date.now() + durationMs;
      let cursor = 0;
      while (Date.now() < deadline && collected.length < maxEvents) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          const item = await ws.waitFor(
            (evt) => !eventFilter || evt?.type === eventFilter,
            { since: cursor, timeoutMs: remaining, label: eventFilter || "any event" }
          );
          cursor = ws.events.indexOf(item) + 1;
          collected.push({
            tMs: roundMs(item.receivedAtMs - startT0),
            event: item.data
          });
        } catch {
          break;
        }
      }
      printJson({
        ok: true,
        as: actor.name,
        connectMs: ws.connectMs,
        durationMs: roundMs(performance.now() - startT0),
        count: collected.length,
        events: collected
      });
    } finally {
      ws.close();
    }
    return;
  }

  if (command === "api") {
    const state = loadState();
    const actor = resolveUser(state);
    const method = String(flags.method || "GET").toUpperCase();
    const apiPath = String(flags.path || "");
    assert(apiPath.startsWith("/"), "api requires --path=/api/v1/...");
    const body = parseJsonFlag(flags.body);
    const res = await actor.request(apiPath, { method, body });
    printJson({ ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, data: res.data });
    return;
  }

  throw new Error(`Unknown command "${command}". Run with --help for usage.`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
