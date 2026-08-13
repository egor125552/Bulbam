import { badRequest } from "../../../core/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_MESSAGE_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const ALLOWED_BITRATES = new Set([24000, 32000, 48000, 64000, 96000]);
const ALLOWED_MIME_TYPES = new Set([
  "audio/mp4;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg"
]);

export function validateVoiceStart(body: Record<string, unknown>) {
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.toLowerCase() : "";
  const bitrateBps = Number(body.bitrateBps);
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    badRequest("unsupported_voice_format", "Нужна запись Opus в MP4, WebM или Ogg.");
  }
  if (!ALLOWED_BITRATES.has(bitrateBps)) {
    badRequest("invalid_voice_bitrate", "Некорректный битрейт голосового сообщения.");
  }
  return { mimeType, bitrateBps };
}

export function validateUploadSessionId(value: string): string {
  if (!UUID.test(value)) badRequest("invalid_voice_upload", "Некорректная сессия загрузки голосового сообщения.");
  return value;
}

export function validateVoiceComplete(body: Record<string, unknown>) {
  const clientMessageId = body.clientMessageId;
  if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
    badRequest("invalid_client_message_id", "Некорректный clientMessageId.");
  }

  const durationMs = Number(body.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isSafeInteger(Math.round(durationMs))) {
    badRequest("invalid_voice_duration", "Некорректная длительность голосового сообщения.");
  }

  const chunkCount = Number(body.chunkCount);
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 100_000) {
    badRequest("invalid_voice_parts", "Некорректное количество частей голосового сообщения.");
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    badRequest("invalid_voice_size", "Некорректный размер голосового сообщения.");
  }

  return {
    clientMessageId,
    durationMs: Math.round(durationMs),
    chunkCount,
    sizeBytes
  };
}

export function validateVoiceProgress(body: Record<string, unknown>) {
  const resumeMs = finiteNonNegative(body.resumeMs, "invalid_voice_progress");
  if (typeof body.completed !== "boolean" || typeof body.active !== "boolean") {
    badRequest("invalid_voice_progress", "Некорректное состояние прослушивания голосового сообщения.");
  }
  if (!Array.isArray(body.heardRanges) || body.heardRanges.length > 256) {
    badRequest("invalid_voice_progress", "Некорректные участки прослушивания голосового сообщения.");
  }
  const heardRanges = body.heardRanges.map((range) => {
    if (!Array.isArray(range) || range.length !== 2) {
      badRequest("invalid_voice_progress", "Некорректные участки прослушивания голосового сообщения.");
    }
    const start = finiteNonNegative(range[0], "invalid_voice_progress");
    const end = finiteNonNegative(range[1], "invalid_voice_progress");
    if (end < start) badRequest("invalid_voice_progress", "Некорректные участки прослушивания голосового сообщения.");
    return [Math.round(start), Math.round(end)] as [number, number];
  });
  return {
    heardRanges,
    resumeMs: Math.round(resumeMs),
    completed: body.completed,
    active: body.active
  };
}

export function validateVoiceShareSetting(body: Record<string, unknown>): boolean {
  if (typeof body.shareListening !== "boolean") {
    badRequest("invalid_voice_setting", "Некорректная настройка приватности голосовых сообщений.");
  }
  return body.shareListening;
}

function finiteNonNegative(value: unknown, code: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    badRequest(code, "Некорректный прогресс голосового сообщения.");
  }
  return number;
}
