import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const PASSWORD = "Bulbam-File-Smoke-2026!";
const CHUNK_SIZE = 1024 * 1024;
const server = createTestHarness({
  workers: [{ configPath: "./wrangler.test.jsonc" }]
});

beforeAll(async () => {
  await server.listen();
});

afterEach(async () => {
  await server.reset();
});

afterAll(async () => {
  await server.close();
});

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got HTTP ${response.status}: ${text}`);
  }
}

async function expectStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${response.status}: ${await response.clone().text()}`);
  }
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)bulbam_session=([^;]+)/);
  if (!match) throw new Error(`No bulbam_session cookie: ${setCookie}`);
  return `bulbam_session=${match[1]}`;
}

async function testEnv() {
  const worker = server.getWorker("bulbam-api-test");
  return worker.getEnv();
}

async function seedInvite(code, inviteId) {
  const ready = await server.fetch("/api/ready");
  await expectStatus(ready, 200);
  const env = await testEnv();
  const hash = createHash("sha256").update(code).digest("hex");
  await env.DB
    .prepare(`
      INSERT INTO invites (
        invite_id, code_hash, created_by_user_id, role_grant,
        created_at, expires_at, used_at, used_by_user_id
      ) VALUES (?, ?, NULL, 'member', ?, NULL, NULL, NULL)
    `)
    .bind(inviteId, hash, Date.now())
    .run();
}

async function register({ username, displayName, inviteCode }) {
  const response = await server.fetch("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName, password: PASSWORD, inviteCode, deviceName: "File smoke" })
  });
  await expectStatus(response, 201);
  const payload = await json(response.clone());
  return { account: payload.account, cookie: sessionCookie(response) };
}

async function api(path, cookie, options = {}) {
  return server.fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body && !(options.body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
      cookie,
      ...(options.headers ?? {})
    }
  });
}

async function openChat(alpha, beta) {
  const response = await api("/api/v1/chats/direct", alpha.cookie, {
    method: "POST",
    body: JSON.stringify({ userId: beta.account.userId })
  });
  await expectStatus(response, 200);
  return (await json(response)).chat;
}

describe("file transfer & inline media playback end-to-end", () => {
  test("uploads multi-chunk binary file in parallel, supports idempotent complete, Range streaming, download filename, and access control", async () => {
    await seedInvite("BULBAM-FILE-SMOKE-0001", "inv-file-1");
    await seedInvite("BULBAM-FILE-SMOKE-0002", "inv-file-2");
    await seedInvite("BULBAM-FILE-SMOKE-0003", "inv-file-3");
    const alice = await register({ username: "file_alice", displayName: "Алиса", inviteCode: "BULBAM-FILE-SMOKE-0001" });
    const bob = await register({ username: "file_bob", displayName: "Боб", inviteCode: "BULBAM-FILE-SMOKE-0002" });
    const outsider = await register({ username: "file_outsider", displayName: "Чужой", inviteCode: "BULBAM-FILE-SMOKE-0003" });
    const chat = await openChat(alice, bob);

    // 2.3 MiB deterministic binary payload (3 chunks: 1 MiB, 1 MiB, 300 KiB).
    const totalSize = CHUNK_SIZE * 2 + 300 * 1024;
    const payload = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i += 1) payload[i] = (i * 31 + 17) & 0xff;

    const startResp = await api(`/api/v1/chats/${chat.conversationId}/files/uploads`, alice.cookie, {
      method: "POST",
      body: JSON.stringify({
        fileName: "Трек концерта.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: totalSize
      })
    });
    await expectStatus(startResp, 201);
    const { upload } = await json(startResp);
    expect(upload.chunkSizeBytes).toBe(CHUNK_SIZE);
    expect(upload.partCount).toBe(3);
    expect(upload.mediaKind).toBe("audio");

    // Upload all 3 parts concurrently in reverse/parallel order to verify atomic DO write serialization!
    const parts = [3, 1, 2].map((partNumber) => {
      const start = (partNumber - 1) * CHUNK_SIZE;
      const end = Math.min(totalSize, start + CHUNK_SIZE);
      return api(
        `/api/v1/chats/${chat.conversationId}/files/uploads/${upload.sessionId}/parts/${partNumber}`,
        alice.cookie,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: payload.slice(start, end)
        }
      );
    });
    const partResponses = await Promise.all(parts);
    for (const resp of partResponses) await expectStatus(resp, 200);

    // Retry part 2 idempotently -> duplicate: true.
    const dupResp = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${upload.sessionId}/parts/2`,
      alice.cookie,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: payload.slice(CHUNK_SIZE, CHUNK_SIZE * 2)
      }
    );
    await expectStatus(dupResp, 200);
    expect((await json(dupResp)).duplicate).toBe(true);

    // Complete upload with caption.
    const clientMessageId = "file_parallel_0001";
    const completeResp = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${upload.sessionId}/complete`,
      alice.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId,
          chunkCount: 3,
          sizeBytes: totalSize,
          text: "Послушай новый микс"
        })
      }
    );
    await expectStatus(completeResp, 201);
    const completed = await json(completeResp);
    expect(completed.duplicate).toBe(false);
    expect(completed.message.kind).toBe("file");
    expect(completed.message.text).toBe("Послушай новый микс");
    expect(completed.message.file).toMatchObject({
      fileName: "Трек концерта.mp3",
      mimeType: "audio/mpeg",
      mediaKind: "audio",
      sizeBytes: totalSize
    });

    // Idempotent retry of complete returns 200 duplicate without creating a second message.
    const completeRetry = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${upload.sessionId}/complete`,
      alice.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId,
          chunkCount: 3,
          sizeBytes: totalSize,
          text: "Послушай новый микс"
        })
      }
    );
    await expectStatus(completeRetry, 200);
    expect((await json(completeRetry)).duplicate).toBe(true);

    // Bob sees the file message in history and chat list preview.
    const historyResp = await api(`/api/v1/chats/${chat.conversationId}/messages`, bob.cookie);
    await expectStatus(historyResp, 200);
    const { messages } = await json(historyResp);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("file");
    expect(messages[0].file.fileName).toBe("Трек концерта.mp3");

    // Inline streaming with Range seeking (spanning across chunk boundary 1 -> 2).
    const rangeStart = CHUNK_SIZE - 512;
    const rangeEnd = CHUNK_SIZE + 511;
    const rangeResp = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${completed.message.messageId}/file`,
      bob.cookie,
      { headers: { range: `bytes=${rangeStart}-${rangeEnd}` } }
    );
    await expectStatus(rangeResp, 206);
    expect(rangeResp.headers.get("content-type")).toBe("audio/mpeg");
    expect(rangeResp.headers.get("content-range")).toBe(`bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
    expect(rangeResp.headers.get("content-disposition")).toContain("inline;");
    expect(rangeResp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rangeResp.headers.get("vary")).toContain("Cookie");
    const rangeBytes = new Uint8Array(await rangeResp.arrayBuffer());
    expect(rangeBytes).toEqual(payload.slice(rangeStart, rangeEnd + 1));

    // Forced download returns attachment Content-Disposition with encoded UTF-8 filename.
    const downloadResp = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${completed.message.messageId}/file?download=1`,
      bob.cookie
    );
    await expectStatus(downloadResp, 200);
    expect(downloadResp.headers.get("content-disposition")).toContain("attachment;");
    expect(downloadResp.headers.get("content-disposition")).toContain(encodeURIComponent("Трек концерта.mp3"));
    const fullBytes = new Uint8Array(await downloadResp.arrayBuffer());
    expect(fullBytes).toEqual(payload);

    // Outsider cannot read the file.
    const forbidden = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${completed.message.messageId}/file`,
      outsider.cookie
    );
    await expectStatus(forbidden, 404);
  }, 30_000);

  test("forces attachment & sandbox headers for SVG/HTML files and supports upload cancellation", async () => {
    await seedInvite("BULBAM-FILE-SEC-0001", "inv-sec-1");
    await seedInvite("BULBAM-FILE-SEC-0002", "inv-sec-2");
    const alice = await register({ username: "sec_alice", displayName: "Алиса", inviteCode: "BULBAM-FILE-SEC-0001" });
    const bob = await register({ username: "sec_bob", displayName: "Боб", inviteCode: "BULBAM-FILE-SEC-0002" });
    const chat = await openChat(alice, bob);

    const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const startResp = await api(`/api/v1/chats/${chat.conversationId}/files/uploads`, alice.cookie, {
      method: "POST",
      body: JSON.stringify({ fileName: "exploit.svg", mimeType: "image/svg+xml", sizeBytes: svgBytes.byteLength })
    });
    await expectStatus(startResp, 201);
    const { upload } = await json(startResp);
    expect(upload.mediaKind).toBe("file");

    const putResp = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${upload.sessionId}/parts/1`,
      alice.cookie,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: svgBytes }
    );
    await expectStatus(putResp, 200);

    const completeResp = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${upload.sessionId}/complete`,
      alice.cookie,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: "sec_svg_00000001",
          chunkCount: 1,
          sizeBytes: svgBytes.byteLength
        })
      }
    );
    await expectStatus(completeResp, 201);
    const { message } = await json(completeResp);

    const serveResp = await api(
      `/api/v1/chats/${chat.conversationId}/messages/${message.messageId}/file`,
      bob.cookie
    );
    await expectStatus(serveResp, 200);
    expect(serveResp.headers.get("content-type")).toBe("application/octet-stream");
    expect(serveResp.headers.get("content-disposition")).toContain("attachment;");
    expect(serveResp.headers.get("content-security-policy")).toContain("sandbox");
    expect(serveResp.headers.get("x-content-type-options")).toBe("nosniff");

    // Upload cancellation deletes in-progress session cleanly.
    const cancelStart = await api(`/api/v1/chats/${chat.conversationId}/files/uploads`, alice.cookie, {
      method: "POST",
      body: JSON.stringify({ fileName: "draft.zip", mimeType: "application/zip", sizeBytes: 4096 })
    });
    await expectStatus(cancelStart, 201);
    const cancelUpload = (await json(cancelStart)).upload;

    const delResp = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${cancelUpload.sessionId}`,
      alice.cookie,
      { method: "DELETE" }
    );
    await expectStatus(delResp, 204);

    const inspectResp = await api(
      `/api/v1/chats/${chat.conversationId}/files/uploads/${cancelUpload.sessionId}`,
      alice.cookie
    );
    await expectStatus(inspectResp, 404);
  }, 30_000);
});
