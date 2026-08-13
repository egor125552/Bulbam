import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  appendVoiceChunk,
  createVoiceDraft,
  getVoiceDraft,
  getVoicePartBlob
} from "../web/js/voice-drafts.js";

const DB_NAME = "bulbam-voice-v1";

beforeEach(async () => {
  await deleteDatabase();
});

describe("voice draft IndexedDB v2", () => {
  test("indexes cumulative byte offsets and reads only the requested cross-chunk range", async () => {
    await appendVoiceChunk("recording-new", 0, blob([0, 1, 2, 3]));
    await appendVoiceChunk("recording-new", 1, blob([4, 5, 6]));
    await appendVoiceChunk("recording-new", 2, blob([7, 8, 9, 10, 11]));

    const part = await getVoicePartBlob("recording-new", 2, 7, "audio/webm;codecs=opus");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4, 5, 6, 7, 8]);

    const db = await openCurrentDatabase();
    const transaction = db.transaction("chunks", "readonly");
    const entries = await requestDone(transaction.objectStore("chunks").getAll());
    await transactionDone(transaction);
    db.close();

    expect(entries.map(({ sequence, startByte }) => ({ sequence, startByte }))).toEqual([
      { sequence: 0, startByte: 0 },
      { sequence: 1, startByte: 4 },
      { sequence: 2, startByte: 7 }
    ]);
  });

  test("commits each audio chunk together with the draft byte counters", async () => {
    await createVoiceDraft({
      id: "recording-atomic",
      accountId: "account-1",
      conversationId: "conversation-1",
      sequence: 0,
      totalBytes: 0,
      startedAt: 100,
      lastChunkAt: 100,
      state: "recording"
    });

    await appendVoiceChunk("recording-atomic", 0, blob([1, 2, 3]));
    let draft = await getVoiceDraft("recording-atomic");
    expect(draft.sequence).toBe(1);
    expect(draft.totalBytes).toBe(3);
    expect(draft.lastChunkAt).toBeGreaterThan(100);

    await appendVoiceChunk("recording-atomic", 1, blob([4, 5]));
    draft = await getVoiceDraft("recording-atomic");
    expect(draft.sequence).toBe(2);
    expect(draft.totalBytes).toBe(5);

    // Rewriting the same indexed chunk must not double-count its bytes.
    await appendVoiceChunk("recording-atomic", 1, blob([4, 5]));
    draft = await getVoiceDraft("recording-atomic");
    expect(draft.sequence).toBe(2);
    expect(draft.totalBytes).toBe(5);
  });

  test("upgrades old chunks without startByte and keeps them readable through the legacy fallback", async () => {
    await createLegacyDatabase([
      { recordingId: "recording-old", sequence: 0, blob: blob([10, 11, 12]), size: 3 },
      { recordingId: "recording-old", sequence: 1, blob: blob([13, 14, 15, 16]), size: 4 }
    ]);

    const beforeAppend = await getVoicePartBlob("recording-old", 2, 4, "audio/webm;codecs=opus");
    expect([...new Uint8Array(await beforeAppend.arrayBuffer())]).toEqual([12, 13, 14, 15]);

    await appendVoiceChunk("recording-old", 2, blob([17, 18]));
    const afterAppend = await getVoicePartBlob("recording-old", 5, 4, "audio/webm;codecs=opus");
    expect([...new Uint8Array(await afterAppend.arrayBuffer())]).toEqual([15, 16, 17, 18]);

    const db = await openCurrentDatabase();
    const transaction = db.transaction("chunks", "readonly");
    const appended = await requestDone(transaction.objectStore("chunks").get(["recording-old", 2]));
    await transactionDone(transaction);
    db.close();

    expect(Object.hasOwn(appended, "startByte")).toBe(false);
  });
});

function blob(bytes) {
  return new Blob([new Uint8Array(bytes)], { type: "audio/webm;codecs=opus" });
}

async function createLegacyDatabase(entries) {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("drafts", { keyPath: "id" });
    const chunks = db.createObjectStore("chunks", { keyPath: ["recordingId", "sequence"] });
    chunks.createIndex("recordingId", "recordingId", { unique: false });
  };
  const db = await requestDone(request);
  const transaction = db.transaction("chunks", "readwrite");
  const store = transaction.objectStore("chunks");
  for (const entry of entries) store.put(entry);
  await transactionDone(transaction);
  db.close();
}

async function openCurrentDatabase() {
  return requestDone(indexedDB.open(DB_NAME, 2));
}

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB test database deletion was blocked"));
  });
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
