import { badRequest } from "../../../core/errors";
import type { R2UploadedPart } from "../../../platform/cloudflare";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_MESSAGE_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const ALLOWED_BITRATES = new Set([24000, 32000, 48000, 64000, 96000]);
const ALLOWED_MIME_TYPES = new Set([
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg"
]);

export function validateVoiceStart(body: Record<string, unknown>) {
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.toLowerCase() : "";
  const bitrateBps = Number(body.bitrateBps);
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    badRequest("unsupported_voice_format", "Нужна запись Opus в WebM или Ogg.");
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

export function validateUploadId(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048) {
    badRequest("invalid_voice_upload", "Некорректный uploadId голосового сообщения.");
  }
  return value;
}

export function validatePartNumber(value: string): number {
  const partNumber = Number(value);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    badRequest("invalid_voice_part", "Некорректный номер части голосового сообщения.");
  }
  return partNumber;
}

export function validateVoiceComplete(body: Record<string, unknown>) {
  const uploadId = validateUploadId(body.uploadId);
  const clientMessageId = body.clientMessageId;
  if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
    badRequest("invalid_client_message_id", "Некорректный clientMessageId.");
  }

  const durationMs = Number(body.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isSafeInteger(Math.round(durationMs))) {
    badRequest("invalid_voice_duration", "Некорректная длительность голосового сообщения.");
  }

  if (!Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > 10000) {
    badRequest("invalid_voice_parts", "Некорректный список загруженных частей.");
  }

  const parts = body.parts.map((part, index) => validatePart(part, index + 1));
  parts.sort((left, right) => left.partNumber - right.partNumber);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].partNumber !== index + 1) {
      badRequest("invalid_voice_parts", "Части голосового сообщения должны идти подряд с номера 1.");
    }
  }

  const mimeType = typeof body.mimeType === "string" ? body.mimeType.toLowerCase() : "";
  const bitrateBps = Number(body.bitrateBps);
  if (!ALLOWED_MIME_TYPES.has(mimeType) || !ALLOWED_BITRATES.has(bitrateBps)) {
    badRequest("invalid_voice_metadata", "Некорректные параметры голосового сообщения.");
  }

  return {
    uploadId,
    clientMessageId,
    durationMs: Math.round(durationMs),
    mimeType,
    bitrateBps,
    parts
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

function validatePart(value: unknown, fallbackNumber: number): R2UploadedPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest("invalid_voice_parts", "Некорректная часть голосового сообщения.");
  }
  const part = value as Record<string, unknown>;
  const partNumber = Number(part.partNumber ?? fallbackNumber);
  const etag = part.etag;
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 || typeof etag !== "string" || etag.length < 1 || etag.length > 256) {
    badRequest("invalid_voice_parts", "Некорректная часть голосового сообщения.");
  }
  return { partNumber, etag };
}

function finiteNonNegative(value: unknown, code: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    badRequest(code, "Некорректный прогресс голосового сообщения.");
  }
  return number;
}
