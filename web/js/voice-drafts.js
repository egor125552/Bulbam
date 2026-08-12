const DB_NAME = "bulbam-voice-v1";
const DB_VERSION = 1;
const DRAFTS = "drafts";
const CHUNKS = "chunks";

export async function createVoiceDraft(draft) {
  const db = await openDb();
  const transaction = db.transaction(DRAFTS, "readwrite");
  await requestDone(transaction.objectStore(DRAFTS).put(draft));
  await transactionDone(transaction);
}

export async function updateVoiceDraft(id, patch) {
  const db = await openDb();
  const transaction = db.transaction(DRAFTS, "readwrite");
  const store = transaction.objectStore(DRAFTS);
  const current = await requestDone(store.get(id));
  if (!current) return null;
  const next = { ...current, ...patch, id };
  await requestDone(store.put(next));
  await transactionDone(transaction);
  return next;
}

export async function appendVoiceChunk(recordingId, sequence, blob) {
  const db = await openDb();
  const transaction = db.transaction(CHUNKS, "readwrite");
  await requestDone(transaction.objectStore(CHUNKS).put({ recordingId, sequence, blob, size: blob.size }));
  await transactionDone(transaction);
}

export async function getVoiceDraft(id) {
  const db = await openDb();
  return requestDone(db.transaction(DRAFTS).objectStore(DRAFTS).get(id));
}

export async function getVoicePartBlob(recordingId, startByte, length, mimeType) {
  const db = await openDb();
  const transaction = db.transaction(CHUNKS, "readonly");
  const index = transaction.objectStore(CHUNKS).index("recordingId");
  const request = index.openCursor(IDBKeyRange.only(recordingId));
  const slices = [];
  let offset = 0;
  const endByte = startByte + length;

  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || offset >= endByte) {
        resolve();
        return;
      }
      const entry = cursor.value;
      const size = Number(entry.size ?? entry.blob?.size ?? 0);
      const chunkStart = offset;
      const chunkEnd = offset + size;
      if (chunkEnd > startByte && chunkStart < endByte && entry.blob) {
        const sliceStart = Math.max(0, startByte - chunkStart);
        const sliceEnd = Math.min(size, endByte - chunkStart);
        if (sliceEnd > sliceStart) slices.push(entry.blob.slice(sliceStart, sliceEnd));
      }
      offset = chunkEnd;
      cursor.continue();
    };
  });
  await transactionDone(transaction);
  return new Blob(slices, { type: mimeType });
}

export async function findRecoverableVoiceDraft(accountId, conversationId) {
  const db = await openDb();
  const drafts = await requestDone(db.transaction(DRAFTS).objectStore(DRAFTS).getAll());
  const candidates = drafts
    .filter((draft) => draft.accountId === accountId && draft.conversationId === conversationId && draft.state !== "sent")
    .sort((left, right) => right.startedAt - left.startedAt);
  const draft = candidates[0] ?? null;
  if (draft?.state === "recording") {
    return updateVoiceDraft(draft.id, {
      state: "interrupted",
      upload: null,
      interruptionReason: "Запись была прервана системой или закрытием приложения."
    });
  }
  return draft;
}

export async function deleteVoiceDraft(recordingId) {
  const db = await openDb();
  const transaction = db.transaction([DRAFTS, CHUNKS], "readwrite");
  transaction.objectStore(DRAFTS).delete(recordingId);
  const index = transaction.objectStore(CHUNKS).index("recordingId");
  const cursorRequest = index.openKeyCursor(IDBKeyRange.only(recordingId));
  await new Promise((resolve, reject) => {
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      transaction.objectStore(CHUNKS).delete(cursor.primaryKey);
      cursor.continue();
    };
  });
  await transactionDone(transaction);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFTS)) {
        db.createObjectStore(DRAFTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const chunks = db.createObjectStore(CHUNKS, { keyPath: ["recordingId", "sequence"] });
        chunks.createIndex("recordingId", "recordingId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
