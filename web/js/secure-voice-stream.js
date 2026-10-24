import { decryptVoicePart, parseEncryptedVoiceMime, VOICE_CIPHER_CHUNK_BYTES, MAX_PROTECTED_VOICE_BYTES } from "./secure-voice.js";

const MAX_PARTS = Math.ceil(MAX_PROTECTED_VOICE_BYTES / (VOICE_CIPHER_CHUNK_BYTES - 16));
const MAX_CIPHER_BYTES = MAX_PROTECTED_VOICE_BYTES + MAX_PARTS * 16;

export function protectedVoiceRanges(ciphertextBytes) {
  if (!Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 17 || ciphertextBytes > MAX_CIPHER_BYTES) {
    throw new Error("Неверный размер защищённого голосового.");
  }
  const count = Math.ceil(ciphertextBytes / VOICE_CIPHER_CHUNK_BYTES);
  const finalBytes = ciphertextBytes - (count - 1) * VOICE_CIPHER_CHUNK_BYTES;
  if (finalBytes < 17) throw new Error("Повреждён конец защищённого голосового.");
  return Array.from({ length: count }, (_, index) => ({
    partNumber: index + 1,
    start: index * VOICE_CIPHER_CHUNK_BYTES,
    end: Math.min(ciphertextBytes, (index + 1) * VOICE_CIPHER_CHUNK_BYTES) - 1
  }));
}

export function selectVoiceSourceType(mime, source = globalThis) {
  const inner = parseEncryptedVoiceMime(mime);
  if (!inner) return null;
  const formats = {
    "audio/mp4": ['audio/mp4; codecs="mp4a.40.2"'],
    "audio/webm;codecs=opus": ['audio/webm; codecs="opus"'],
    "audio/webm": ['audio/webm; codecs="opus"', "audio/webm"],
    "audio/ogg;codecs=opus": ['audio/ogg; codecs="opus"'],
    "audio/ogg": ['audio/ogg; codecs="opus"', "audio/ogg"]
  };
  const providers = [source.ManagedMediaSource, source.MediaSource];
  for (const provider of providers) {
    if (typeof provider !== "function" || typeof provider.isTypeSupported !== "function") continue;
    for (const type of formats[inner.mimeType] ?? []) {
      if (provider.isTypeSupported(type)) return { constructor: provider, type };
    }
  }
  return null;
}

export async function* readProtectedVoiceChunks({
  url, mimeType, ciphertextBytes, key, context, fetchImpl = fetch, signal, isStillAuthorized = () => true
}) {
  parseEncryptedVoiceMime(mimeType);
  const ranges = protectedVoiceRanges(ciphertextBytes);
  const totalPlainBytes = ciphertextBytes - ranges.length * 16;
  for (const { partNumber, start, end } of ranges) {
    if (signal?.aborted || !isStillAuthorized()) throw new Error("Прослушивание отменено.");
    const response = await fetchImpl(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Range: `bytes=${start}-${end}` },
      signal
    });
    if (response.status !== 206) throw new Error("Сервер не поддержал безопасную загрузку части голосового.");
    const range = response.headers.get("content-range");
    if (range !== `bytes ${start}-${end}/${ciphertextBytes}`) {
      throw new Error("Сервер вернул другую часть голосового.");
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== end - start + 1) {
      throw new Error("Неверный размер полученной части.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - start + 1) throw new Error("Часть голосового повреждена или неполная.");
    if (signal?.aborted || !isStillAuthorized()) throw new Error("Прослушивание отменено.");
    const plaintext = await decryptVoicePart(bytes, key, mimeType, context, partNumber,
      partNumber === ranges.length ? totalPlainBytes : null);
    if (!isStillAuthorized() || signal?.aborted) throw new Error("Прослушивание отменено.");
    yield new Uint8Array(plaintext);
  }
}

function waitEvent(target, success, failure, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      target.removeEventListener(success, yes);
      if (failure) target.removeEventListener(failure, no);
      signal?.removeEventListener("abort", aborted);
    };
    const yes = () => { clean(); resolve(); };
    const no = () => { clean(); reject(new Error("Ошибка декодера потокового звука.")); };
    const aborted = () => { clean(); reject(new Error("Прослушивание остановлено.")); };
    target.addEventListener(success, yes, { once: true });
    if (failure) target.addEventListener(failure, no, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export function createProtectedVoiceStream({
  audio, url, mimeType, ciphertextBytes, key, context, isStillAuthorized, fetchImpl
}) {
  const type = selectVoiceSourceType(mimeType);
  if (!type) return null;
  const aborter = new AbortController();
  const mediaSource = new type.constructor();
  // ManagedMediaSource on iPhone needs AirPlay disabled or sourceopen never fires.
  audio.disableRemotePlayback = true;
  const objectUrl = URL.createObjectURL(mediaSource);
  audio.src = objectUrl;
  let stop = false;
  const pending = (async () => {
    try {
      await waitEvent(mediaSource, "sourceopen", "error", aborter.signal);
      if (stop) return;
      const buffer = mediaSource.addSourceBuffer(type.type);
      const chunks = readProtectedVoiceChunks({
        url, mimeType, ciphertextBytes, key, context, isStillAuthorized, signal: aborter.signal, fetchImpl
      });
      for await (const chunk of chunks) {
        if (stop) return;
        // Backpressure: keep about 25s of decoded audio ahead of playback.
        while (!stop && buffer.buffered.length &&
          buffer.buffered.end(buffer.buffered.length - 1) - audio.currentTime > 25 &&
          !audio.seeking) {
          // Pause network reads while enough authenticated audio is buffered.
          // A short polling pause avoids accumulating stale event listeners.
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (aborter.signal.aborted || !isStillAuthorized()) throw new Error("Прослушивание отменено.");
        }
        if (stop) return;
        buffer.appendBuffer(chunk);
        await waitEvent(buffer, "updateend", "error", aborter.signal);
      }
      if (stop) return;
      if (mediaSource.readyState === "open" && !buffer.updating) mediaSource.endOfStream();
    } catch (error) {
      if (!stop) throw error;
    }
  })();
  return {
    objectUrl,
    done: pending,
    stop() {
      stop = true;
      aborter.abort();
      try { if (mediaSource.readyState === "open") mediaSource.endOfStream(); } catch {}
    }
  };
}
