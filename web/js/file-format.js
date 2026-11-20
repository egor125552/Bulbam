import { language, translateText } from "./i18n.js";

export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  const be = language() === "be";
  const units = be ? ["Б", "КБ", "МБ", "ГБ"] : ["Б", "КБ", "МБ", "ГБ"];
  if (value < 1024) return `${Math.round(value)} ${units[0]}`;
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  const formatted = size.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1").replace(".", ",");
  return `${formatted} ${units[index]}`;
}

export function formatTransferSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${formatFileSize(value)}/с`;
}

export function formatMediaDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function fileExtensionLabel(fileName) {
  const name = String(fileName ?? "");
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  const ext = name.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return ext ? ext.slice(0, 6) : "FILE";
}

export function fileMediaKindLabel(mediaKind) {
  if (mediaKind === "image") return translateText("Фото");
  if (mediaKind === "video") return translateText("Видео");
  if (mediaKind === "audio") return translateText("Аудио");
  return translateText("Файл");
}

export function filePreviewText(file, caption = "") {
  if (!file) return translateText("Файл");
  const label = fileMediaKindLabel(file.mediaKind);
  const name = String(file.fileName ?? "").trim() || translateText("Файл");
  const cleanCaption = String(caption ?? "").replace(/\s+/g, " ").trim();
  return cleanCaption ? `${label}: ${name} — ${cleanCaption}` : `${label}: ${name}`;
}

export function buildFileUrl(conversationId, messageId, { download = false } = {}) {
  const base = `/api/v1/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/file`;
  return download ? `${base}?download=1` : base;
}

export function computeUploadProgress(partLoadedMap, totalBytes) {
  const safeTotal = Math.max(1, Number(totalBytes) || 1);
  let loadedBytes = 0;
  for (const bytes of partLoadedMap.values()) {
    if (Number.isFinite(bytes) && bytes > 0) loadedBytes += bytes;
  }
  loadedBytes = Math.min(safeTotal, Math.round(loadedBytes));
  const percent = Math.max(0, Math.min(100, Math.round((loadedBytes / safeTotal) * 100)));
  return { loadedBytes, totalBytes: safeTotal, percent };
}
