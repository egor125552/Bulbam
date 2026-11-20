import { describe, expect, test } from "vitest";
import {
  classifyFileMedia,
  FILE_CHUNK_SIZE_BYTES,
  formatContentDisposition,
  MAX_FILE_SIZE_BYTES,
  sanitizeFileName,
  validateFileComplete,
  validateFilePartNumber,
  validateFileStart
} from "../worker/src/modules/media/domain/file-validation";
import {
  buildFileUrl,
  computeUploadProgress,
  fileExtensionLabel,
  filePreviewText,
  formatFileSize,
  formatMediaDuration,
  formatTransferSpeed
} from "../web/js/file-format.js";
import { chatPreview } from "../web/js/chat-presentation.js";

describe("file validation and security classification", () => {
  test("sanitizes path traversal, control characters, and bidi spoofing", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\demo\\фото\r\n.png")).toBe("фото.png");
    expect(sanitizeFileName("invoice_\u202egpj.exe")).toBe("invoice_gpj.exe");
    expect(sanitizeFileName("   ..  ")).toBe("file");
    const longName = `${"a".repeat(250)}.mp3`;
    const sanitized = sanitizeFileName(longName);
    expect(sanitized.length).toBeLessThanOrEqual(200);
    expect(sanitized.endsWith(".mp3")).toBe(true);
  });

  test("classifies safe inline photos, videos, and music/audio", () => {
    expect(classifyFileMedia("image/png", "photo.png")).toEqual({
      mimeType: "image/png",
      mediaKind: "image",
      safeInline: true
    });
    expect(classifyFileMedia("video/mp4", "clip.mp4")).toEqual({
      mimeType: "video/mp4",
      mediaKind: "video",
      safeInline: true
    });
    expect(classifyFileMedia("audio/mpeg", "song.mp3")).toEqual({
      mimeType: "audio/mpeg",
      mediaKind: "audio",
      safeInline: true
    });
    expect(classifyFileMedia("application/octet-stream", "track.flac")).toEqual({
      mimeType: "audio/flac",
      mediaKind: "audio",
      safeInline: true
    });
    expect(classifyFileMedia("application/zip", "archive.zip")).toEqual({
      mimeType: "application/zip",
      mediaKind: "file",
      safeInline: false
    });
  });

  test("never marks SVG, HTML, XML, or JS as inline media", () => {
    for (const [mime, name] of [
      ["image/svg+xml", "vector.svg"],
      ["text/html", "page.html"],
      ["application/xhtml+xml", "page.xhtml"],
      ["application/javascript", "script.js"],
      ["application/octet-stream", "sneaky.svg"],
      ["image/png", "pretend.html"]
    ]) {
      const classified = classifyFileMedia(mime, name);
      expect(classified.mediaKind).toBe("file");
      expect(classified.safeInline).toBe(false);
      expect(classified.mimeType).toBe("application/octet-stream");
    }
  });

  test("formats RFC 5987 Content-Disposition safely for Cyrillic filenames", () => {
    const header = formatContentDisposition("attachment", "Отчёт 2026.pdf");
    expect(header).toContain("attachment;");
    expect(header).toContain("filename*=");
    expect(header).toContain(encodeURIComponent("Отчёт 2026.pdf"));
    expect(header).not.toMatch(/[\r\n]/);
  });

  test("validates file start, parts, and complete payloads", () => {
    const started = validateFileStart({
      fileName: "Музыка.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: FILE_CHUNK_SIZE_BYTES * 2 + 123
    });
    expect(started.mediaKind).toBe("audio");
    expect(started.partCount).toBe(3);

    expect(() => validateFileStart({ fileName: "empty.txt", sizeBytes: 0 })).toThrow();
    expect(() => validateFileStart({ fileName: "huge.bin", sizeBytes: MAX_FILE_SIZE_BYTES + 1 })).toThrow();
    expect(validateFilePartNumber("4")).toBe(4);
    expect(() => validateFilePartNumber("0")).toThrow();
    expect(() => validateFilePartNumber("abc")).toThrow();

    const completed = validateFileComplete({
      clientMessageId: "file_msg_12345678",
      chunkCount: 3,
      sizeBytes: FILE_CHUNK_SIZE_BYTES * 2 + 123,
      text: "  Любимый трек  "
    });
    expect(completed.caption).toBe("Любимый трек");
  });
});

describe("frontend file formatting and progress calculation", () => {
  test("formats sizes, speeds, durations, extensions, and URLs", () => {
    expect(formatFileSize(512)).toBe("512 Б");
    expect(formatFileSize(1536)).toBe("1,5 КБ");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10 МБ");
    expect(formatTransferSpeed(2 * 1024 * 1024)).toBe("2 МБ/с");
    expect(formatMediaDuration(65)).toBe("1:05");
    expect(formatMediaDuration(3661)).toBe("1:01:01");
    expect(fileExtensionLabel("my.song.flac")).toBe("FLAC");
    expect(fileExtensionLabel("README")).toBe("FILE");
    expect(buildFileUrl("c1", "m1")).toBe("/api/v1/chats/c1/messages/m1/file");
    expect(buildFileUrl("c1", "m1", { download: true })).toBe("/api/v1/chats/c1/messages/m1/file?download=1");
  });

  test("aggregates parallel chunk progress safely between 0 and 100%", () => {
    const map = new Map([
      [1, 500],
      [2, 250]
    ]);
    expect(computeUploadProgress(map, 1000)).toEqual({
      loadedBytes: 750,
      totalBytes: 1000,
      percent: 75
    });
    map.set(3, 600);
    expect(computeUploadProgress(map, 1000)).toEqual({
      loadedBytes: 1000,
      totalBytes: 1000,
      percent: 100
    });
  });

  test("renders filename in chat preview for file messages", () => {
    const msg = {
      senderUserId: "u2",
      kind: "file",
      text: "",
      file: { fileName: "Концерт.mp3", mediaKind: "audio", sizeBytes: 4096 }
    };
    expect(filePreviewText(msg.file)).toBe("Аудио: Концерт.mp3");
    expect(chatPreview(msg, "u1")).toBe("Аудио: Концерт.mp3");
    expect(chatPreview(msg, "u2")).toBe("Вы: Аудио: Концерт.mp3");
  });
});
