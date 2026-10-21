import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, extname, join, sep } from "node:path";
import { createTestHarness } from "wrangler";

const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const TEST_PASSWORD = "AccessPilot-Local-2026-Test!";
const TEST_INVITE = "ACCESSPILOT-ISOLATED-ACCOUNT-2026";
const demo = { userId: "accesspilot-peer-2", username: "pilot_peer", displayName: "Тестовый собеседник" };

export async function launchBulbamTestHost() {
  const harness = createTestHarness({ workers: [{ configPath: "./wrangler.test.jsonc" }] });
  await harness.listen();
  const ready = await harness.fetch("/api/ready");
  if (!ready.ok) throw new Error("Isolated worker not ready: " + await ready.text());
  const worker = harness.getWorker("bulbam-api-test");
  const { DB } = await worker.getEnv();
  await DB.prepare(`INSERT INTO invites
    (invite_id, code_hash, created_by_user_id, role_grant, created_at, expires_at, used_at, used_by_user_id)
    VALUES (?, ?, NULL, 'owner', ?, NULL, NULL, NULL)`)
    .bind("accesspilot-owner-invite", createHash("sha256").update(TEST_INVITE).digest("hex"), Date.now()).run();

  const init = await harness.fetch("/api/v1/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "accesspilot_owner", password: TEST_PASSWORD, inviteCode: TEST_INVITE,
      deviceName: "AccessPilot isolated fixture" })
  });
  if (init.status !== 201) throw new Error("Failed to seed owner: " + init.status + " " + await init.text());
  const initPayload = await init.json();
  const cookie = (init.headers.get("set-cookie") ?? "").match(/bulbam_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error("Isolated session cookie missing");

  // Register a second account in the same isolated worker for real searches, chats
  // and messaging. These are test users, never production identities.
  let peerCookie = null;
  try {
    const env = await worker.getEnv();
    const secondCode = "ACCESSPILOT-PEER-ISOLATED-2026";
    await env.DB.prepare(`INSERT INTO invites
      (invite_id, code_hash, created_by_user_id, role_grant, created_at, expires_at, used_at, used_by_user_id)
      VALUES (?, ?, ?, 'member', ?, NULL, NULL, NULL)`)
      .bind("accesspilot-peer-invite", createHash("sha256").update(secondCode).digest("hex"), initPayload.account.userId, Date.now()).run();
    const peer = await harness.fetch("/api/v1/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "pilot_peer", password: TEST_PASSWORD, inviteCode: secondCode,
        deviceName: "AccessPilot peer fixture" })
    });
    if (peer.status !== 201) throw new Error("Failed to seed peer: " + await peer.text());
    const peerPayload = await peer.json();
    demo.userId = peerPayload.account.userId;
    peerCookie = (peer.headers.get("set-cookie") ?? "").match(/bulbam_session=([^;]+)/)?.[1];
  } catch (error) {
    await harness.close();
    throw error;
  }
  // Add a real direct chat and synthetic messages through the isolated
  // backend so the browser renders conversation and message actions.
  const open = await harness.fetch("/api/v1/chats/direct", {
    method: "POST", headers: { "content-type": "application/json", cookie: "bulbam_session=" + cookie },
    body: JSON.stringify({ userId: demo.userId })
  });
  if (!open.ok) throw new Error("Unable to seed isolated direct chat: " + await open.text());
  const seededChat=(await open.json()).chat;
  const sample=await harness.fetch(`/api/v1/chats/${seededChat.conversationId}/messages`,{
    method:"POST",headers:{"content-type":"application/json",cookie:"bulbam_session="+peerCookie},
    body:JSON.stringify({clientMessageId:"accesspilot-fixture-message-1",
      text:"Привет! Это тестовое сообщение AccessPilot в отдельной базе."})
  });
  if(!sample.ok)throw new Error("Failed to seed fixture message: "+await sample.text());

  const base = resolve("web");
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const method = request.method ?? "GET";
        const reqHeaders = new Headers();
        for (const name of ["cookie", "content-type", "accept-language"]) {
          const value = request.headers[name];
          if (typeof value === "string") reqHeaders.set(name, value);
        }
        const fetched = await harness.fetch(url.pathname + url.search, {
          method, headers: reqHeaders, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) })
        });
        response.writeHead(fetched.status, Object.fromEntries([...fetched.headers]
          .filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name))));
        response.end(Buffer.from(await fetched.arrayBuffer()));
        return;
      }
      const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const path = resolve(base, "." + pathname);
      if (!path.startsWith(base + sep)) { response.writeHead(403); response.end(); return; }
      const contents = await readFile(path);
      response.setHeader("content-type", mime[extname(path)] ?? "application/octet-stream");
      response.setHeader("cache-control", "no-store");
      response.end(contents);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500);
      response.end("Isolated test server error");
    }
  });
  await new Promise(resolveListening => server.listen(0, "127.0.0.1", resolveListening));
  const port = server.address().port;
  return {
    baseURL: "http://127.0.0.1:" + port,
    cookie,
    async issueSession() {
      const response=await harness.fetch("/api/v1/auth/login", {
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({username:"accesspilot_owner",password:TEST_PASSWORD,
          deviceName:"AccessPilot isolated replay"})
      });
      if(!response.ok)throw new Error("Test session recreation failed: "+response.status);
      const value=(response.headers.get("set-cookie")||"").match(/bulbam_session=([^;]+)/)?.[1];
      if(!value)throw new Error("Test session cookie missing");
      return value;
    },
    account: initPayload.account,
    peerCookie,
    getTestEnvironment: () => harness,
    async close() { await new Promise(done => server.close(done)); await harness.close(); }
  };
}
