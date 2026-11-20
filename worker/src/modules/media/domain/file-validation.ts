import { badRequest } from "../../../core/errors";
import type { FileMediaKind } from "../../messaging/domain/models";

export const FILE_CHUNK_SIZE_BYTES = 1024 * 1024; // 1 MiB chunks (fits safely inside 2 MiB DO SQLite value limit)
export const MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024; // 512 MiB per file
export const MAX_FILE_PARTS = Math.ceil(MAX_FILE_SIZE_BYTES / FILE_CHUNK_SIZE_BYTES);
const MAX_CAPTION_LENGTH = 4000;
const CLIENT_MESSAGE_ID = /^[a-zA-Z0-9_-]{8,100}$/;

const SAFE_INLINE_IMAGES: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"],
  ["image/webp", "image/webp"],
  ["image/gif", "image/gif"],
  ["image/avif", "image/avif"],
  ["image/bmp", "image/bmp"]
]);

const SAFE_INLINE_VIDEOS: ReadonlyMap<string, string> = new Map([
  ["video/mp4", "video/mp4"],
  ["video/webm", "video/webm"],
  ["video/ogg", "video/ogg"],
  ["video/quicktime", "video/quicktime"],
  ["video/x-m4v", "video/mp4"]
]);

const SAFE_INLINE_AUDIO: ReadonlyMap<string, string> = new Map([
  ["audio/mpeg", "audio/mpeg"],
  ["audio/mp3", "audio/mpeg"],
  ["audio/mp4", "audio/mp4"],
  ["audio/x-m4a", "audio/mp4"],
  ["audio/m4a", "audio/mp4"],
  ["audio/aac", "audio/aac"],
  ["audio/ogg", "audio/ogg"],
  ["audio/opus", "audio/ogg"],
  ["audio/wav", "audio/wav"],
  ["audio/x-wav", "audio/wav"],
  ["audio/wave", "audio/wav"],
  ["audio/flac", "audio/flac"],
  ["audio/x-flac", "audio/flac"],
  ["audio/webm", "audio/webm"]
]);

const EXTENSION_MIME_FALLBACK: ReadonlyMap<string, { mimeType: string; mediaKind: FileMediaKind }> = new Map([
  ["jpg", { mimeType: "image/jpeg", mediaKind: "image" }],
  ["jpeg", { mimeType: "image/jpeg", mediaKind: "image" }],
  ["png", { mimeType: "image/png", mediaKind: "image" }],
  ["webp", { mimeType: "image/webp", mediaKind: "image" }],
  ["gif", { mimeType: "image/gif", mediaKind: "image" }],
  ["avif", { mimeType: "image/avif", mediaKind: "image" }],
  ["bmp", { mimeType: "image/bmp", mediaKind: "image" }],
  ["mp4", { mimeType: "video/mp4", mediaKind: "video" }],
  ["m4v", { mimeType: "video/mp4", mediaKind: "video" }],
  ["webm", { mimeType: "video/webm", mediaKind: "video" }],
  ["mov", { mimeType: "video/quicktime", mediaKind: "video" }],
  ["ogv", { mimeType: "video/ogg", mediaKind: "video" }],
  ["mp3", { mimeType: "audio/mpeg", mediaKind: "audio" }],
  ["m4a", { mimeType: "audio/mp4", mediaKind: "audio" }],
  ["aac", { mimeType: "audio/aac", mediaKind: "audio" }],
  ["ogg", { mimeType: "audio/ogg", mediaKind: "audio" }],
  ["opus", { mimeType: "audio/ogg", mediaKind: "audio" }],
  ["wav", { mimeType: "audio/wav", mediaKind: "audio" }],
  ["flac", { mimeType: "audio/flac", mediaKind: "audio" }],
  ["weba", { mimeType: "audio/webm", mediaKind: "audio" }]
]);

const DANGEROUS_INLINE_MIMES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript"
]);

const DANGEROUS_INLINE_EXTENSIONS = new Set([
  "svg", "svgz", "html", "htm", "xhtml", "xml", "js", "mjs", "cjs", "swf"
]);

export interface ClassifiedFileMedia {
  mimeType: string;
  mediaKind: FileMediaKind;
  safeInline: boolean;
}

export function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== "string") return "file";
  // Strip any path prefix, control chars, and Unicode bidi override chars.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  if (cleaned.length <= 200) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && cleaned.length - dot <= 20) {
    const ext = cleaned.slice(dot);
    return `${cleaned.slice(0, 200 - ext.length).trimEnd()}${ext}`;
  }
  return cleaned.slice(0, 200).trimEnd() || "file";
}

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

export function classifyFileMedia(rawMimeType: unknown, fileName: string): ClassifiedFileMedia {
  const ext = fileExtension(fileName);
  const rawBase = typeof rawMimeType === "string"
    ? rawMimeType.split(";")[0].trim().toLowerCase()
    : "";

  // Active web content (HTML, SVG, XML, JS) is never served inline.
  if (DANGEROUS_INLINE_MIMES.has(rawBase) || DANGEROUS_INLINE_EXTENSIONS.has(ext)) {
    return { mimeType: "application/octet-stream", mediaKind: "file", safeInline: false };
  }

  const inlineImage = SAFE_INLINE_IMAGES.get(rawBase);
  if (inlineImage) return { mimeType: inlineImage, mediaKind: "image", safeInline: true };

  const inlineVideo = SAFE_INLINE_VIDEOS.get(rawBase);
  if (inlineVideo) return { mimeType: inlineVideo, mediaKind: "video", safeInline: true };

  const inlineAudio = SAFE_INLINE_AUDIO.get(rawBase);
  if (inlineAudio) return { mimeType: inlineAudio, mediaKind: "audio", safeInline: true };

  if (!rawBase || rawBase === "application/octet-stream" || rawBase === "binary/octet-stream") {
    const fromExt = EXTENSION_MIME_FALLBACK.get(ext);
    if (fromExt) return { ...fromExt, safeInline: true };
    return { mimeType: "application/octet-stream", mediaKind: "file", safeInline: false };
  }

  const safeMime = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(rawBase)
    ? rawBase
    : "application/octet-stream";
  return { mimeType: safeMime, mediaKind: "file", safeInline: false };
}

export function validateFileStart(body: Record<string, unknown>) {
  if (typeof body.fileName !== "string" || !body.fileName.trim()) {
    badRequest("invalid_file_name", "Укажите название файла.");
  }
  const fileName = sanitizeFileName(body.fileName);
  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    badRequest("invalid_file_size", "Файл пустой или имеет некорректный размер.");
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    badRequest(
      "file_too_large",
      `Файл слишком большой. Максимальный размер — ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} МБ.`
    );
  }
  const classified = classifyFileMedia(body.mimeType, fileName);
  const partCount = Math.ceil(sizeBytes / FILE_CHUNK_SIZE_BYTES);
  return {
    fileName,
    mimeType: classified.mimeType,
    mediaKind: classified.mediaKind,
    sizeBytes,
    partCount
  };
}

export function validateFilePartNumber(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    badRequest("invalid_file_part", "Некорректный номер части файла.");
  }
  const partNumber = Number(raw);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > MAX_FILE_PARTS) {
    badRequest("invalid_file_part", "Некорректный номер части файла.");
  }
  return partNumber;
}

export function validateFileComplete(body: Record<string, unknown>) {
  const clientMessageId = body.clientMessageId;
  if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
    badRequest("invalid_client_message_id", "Некорректный clientMessageId.");
  }

  const chunkCount = Number(body.chunkCount);
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_FILE_PARTS) {
    badRequest("invalid_file_parts", "Некорректное количество частей файла.");
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_SIZE_BYTES) {
    badRequest("invalid_file_size", "Некорректный размер файла.");
  }

  const rawCaption = body.text === undefined || body.text === null ? "" : body.text;
  if (typeof rawCaption !== "string") {
    badRequest("invalid_file_caption", "Подпись к файлу должна быть текстом.");
  }
  const caption = rawCaption.replace(/\r\n?/g, "\n").trim();
  if (caption.length > MAX_CAPTION_LENGTH) {
    badRequest("message_too_long", `Подпись не может быть длиннее ${MAX_CAPTION_LENGTH} символов.`);
  }

  return {
    clientMessageId,
    chunkCount,
    sizeBytes,
    caption
  };
}

export function formatContentDisposition(
  disposition: "inline" | "attachment",
  fileName: string
): string {
  const safe = sanitizeFileName(fileName);
  const ascii = safe
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;]/g, "_")
    .trim() || "file";
  const encoded = encodeURIComponent(safe).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
