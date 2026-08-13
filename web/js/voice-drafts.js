const DB_NAME = "bulbam-voice-v1";
const DB_VERSION = 2;
const DRAFTS = "drafts";
const CHUNKS = "chunks";
const RECORDING_INDEX = "recordingId";
const START_INDEX = "recordingIdStart";

let databasePromise = null;
const liveDraftReferences = new Map();

export async function createVoiceDraft(draft) {
  const db = await openDb();
  const transaction = db.transaction(DRAFTS, "readwrite");
  try {
    await requestDone(transaction.objectStore(DRAFTS).put(draft));
    await transactionDone(transaction);
    liveDraftReferences.set(draft.id, draft);
  } catch (error) {
    liveDraftReferences.delete(draft.id);
    throw error;
  }
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
  const live = liveDraftReferences.get(id);
  if (live) Object.assign(live, next);
  return next;
}

export async function appendVoiceChunk(recordingId, sequence, blob) {
  const db = await openDb();
  const transaction = db.transaction([CHUNKS, DRAFTS], "readwrite");
  const chunkStore = transaction.objectStore(CHUNKS);
  const draftStore = transaction.objectStore(DRAFTS);
  let persistedDraft = null;

  try {
    const existing = await requestDone(chunkStore.get([recordingId, sequence]));
    let startByte = sequence === 0 ? 0 : undefined;
    if (sequence > 0) {
      const previous = await requestDone(chunkStore.get([recordingId, sequence - 1]));
      const previousStart = typeof previous?.startByte === "number" ? previous.startByte : NaN;
      const previousSize = Number(previous?.size ?? previous?.blob?.size ?? NaN);
      if (Number.isFinite(previousStart) && previousStart >= 0 && Number.isFinite(previousSize) && previousSize >= 0) {
        startByte = previousStart + previousSize;
      }
    }

    const entry = { recordingId, sequence, blob, size: blob.size };
    if (Number.isFinite(startByte)) entry.startByte = startByte;
    await requestDone(chunkStore.put(entry));

    const draft = await requestDone(draftStore.get(recordingId));
    if (draft) {
      const currentTotal = Number(draft.totalBytes ?? 0);
      const indexedEnd = Number.isFinite(startByte) ? startByte + blob.size : NaN;
      const totalBytes = existing
        ? Math.max(currentTotal, Number.isFinite(indexedEnd) ? indexedEnd : currentTotal)
        : Number.isFinite(indexedEnd)
          ? Math.max(currentTotal, indexedEnd)
          : currentTotal + blob.size;
      persistedDraft = {
        ...draft,
        id: recordingId,
        sequence: Math.max(Number(draft.sequence ?? 0), sequence + 1),
        totalBytes,
        lastChunkAt: Date.now()
      };
      await requestDone(draftStore.put(persistedDraft));
    }

    await transactionDone(transaction);
  } catch (error) {
    try { transaction.abort(); } catch {}
    throw error;
  }

  if (persistedDraft) {
    const live = liveDraftReferences.get(recordingId);
    if (live) Object.assign(live, persistedDraft);
  }
  dispatchChunkPersisted(recordingId, sequence, blob.size);
}

export async function getVoiceDraft(id) {
  const db = await openDb();
  return requestDone(db.transaction(DRAFTS).objectStore(DRAFTS).get(id));
}

export async function getVoicePartBlob(recordingId, startByte, length, mimeType) {
  const db = await openDb();
  const endByte = startByte + length;
  const startSequence = await findIndexedStartSequence(db, recordingId, startByte);
  if (startSequence != null) {
    const indexed = await readIndexedRange(db, recordingId, startSequence, startByte, endByte);
    if (indexed !== null) return new Blob(indexed, { type: mimeType });
  }
  return readLegacyRange(db, recordingId, startByte, endByte, mimeType);
}

async function findIndexedStartSequence(db, recordingId, startByte) {
  const transaction = db.transaction(CHUNKS, "readonly");
  const store = transaction.objectStore(CHUNKS);
  if (!store.indexNames.contains(START_INDEX)) {
    await transactionDone(transaction);
    return null;
  }
  const index = store.index(START_INDEX);
  const request = index.openCursor(IDBKeyRange.upperBound([recordingId, startByte]), "prev");
  const cursor = await requestDone(request);
  await transactionDone(transaction);
  const entry = cursor?.value;
  if (!entry || entry.recordingId !== recordingId || typeof entry.startByte !== "number" || !Number.isFinite(entry.startByte)) {
    return null;
  }
  return Number(entry.sequence);
}

async function readIndexedRange(db, recordingId, startSequence, startByte, endByte) {
  const transaction = db.transaction(CHUNKS, "readonly");
  const store = transaction.objectStore(CHUNKS);
  const request = store.openCursor(
    IDBKeyRange.bound(
      [recordingId, startSequence],
      [recordingId, Number.MAX_SAFE_INTEGER]
    )
  );
  const slices = [];
  let validIndex = true;

  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const entry = cursor.value;
      const chunkStart = typeof entry.startByte === "number" ? entry.startByte : NaN;
      const size = Number(entry.size ?? entry.blob?.size ?? 0);
      if (!Number.isFinite(chunkStart) || chunkStart < 0 || !entry.blob) {
        validIndex = false;
        resolve();
        return;
      }
      const chunkEnd = chunkStart + size;
      if (chunkStart >= endByte) {
        resolve();
        return;
      }
      if (chunkEnd > startByte && chunkStart < endByte) {
        const sliceStart = Math.max(0, startByte - chunkStart);
        const sliceEnd = Math.min(size, endByte - chunkStart);
        if (sliceEnd > sliceStart) slices.push(entry.blob.slice(sliceStart, sliceEnd));
      }
      cursor.continue();
    };
  });
  await transactionDone(transaction);
  return validIndex ? slices : null;
}

async function readLegacyRange(db, recordingId, startByte, endByte, mimeType) {
  const transaction = db.transaction(CHUNKS, "readonly");
  const index = transaction.objectStore(CHUNKS).index(RECORDING_INDEX);
  const request = index.openCursor(IDBKeyRange.only(recordingId));
  const slices = [];
  let offset = 0;

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
      interruptionReason: "Запись была прервана системой или закрытием приложения."
    });
  }
  return draft;
}

export async function deleteVoiceDraft(recordingId) {
  const db = await openDb();
  const transaction = db.transaction([DRAFTS, CHUNKS], "readwrite");
  transaction.objectStore(DRAFTS).delete(recordingId);
  const index = transaction.objectStore(CHUNKS).index(RECORDING_INDEX);
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
  liveDraftReferences.delete(recordingId);
}

function dispatchChunkPersisted(recordingId, sequence, sizeBytes) {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent("bulbam:voice-chunk-persisted", {
    detail: { recordingId, sequence, sizeBytes }
  }));
}

function openDb() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Обновление локального хранилища голосовых заблокировано другой вкладкой."));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFTS)) {
        db.createObjectStore(DRAFTS, { keyPath: "id" });
      }

      let chunks;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        chunks = db.createObjectStore(CHUNKS, { keyPath: ["recordingId", "sequence"] });
      } else {
        chunks = request.transaction.objectStore(CHUNKS);
      }
      if (!chunks.indexNames.contains(RECORDING_INDEX)) {
        chunks.createIndex(RECORDING_INDEX, "recordingId", { unique: false });
      }
      if (!chunks.indexNames.contains(START_INDEX)) {
        chunks.createIndex(START_INDEX, ["recordingId", "startByte"], { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const reset = () => {
        if (databasePromise) databasePromise = null;
      };
      db.onversionchange = () => {
        db.close();
        reset();
      };
      db.onclose = reset;
      resolve(db);
    };
  });
  return databasePromise;
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