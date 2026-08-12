import type { R2BucketLike, R2UploadedPart } from "../../../platform/cloudflare";
import type { VoiceReadResult, VoiceStorage, VoiceStoredObject } from "../ports/voice-storage";

export class R2VoiceStorage implements VoiceStorage {
  constructor(private readonly bucket: R2BucketLike) {}

  async create(objectKey: string, mimeType: string, bitrateBps: number): Promise<{ uploadId: string }> {
    const upload = await this.bucket.createMultipartUpload(objectKey, {
      httpMetadata: {
        contentType: mimeType,
        cacheControl: "private, max-age=604800, immutable"
      },
      customMetadata: {
        bulbamVoiceMimeType: mimeType,
        bulbamVoiceBitrateBps: String(bitrateBps)
      }
    });
    return { uploadId: upload.uploadId };
  }

  async uploadPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream
  ): Promise<R2UploadedPart> {
    return this.bucket.resumeMultipartUpload(objectKey, uploadId).uploadPart(partNumber, body);
  }

  async complete(objectKey: string, uploadId: string, parts: R2UploadedPart[]): Promise<VoiceStoredObject> {
    const upload = this.bucket.resumeMultipartUpload(objectKey, uploadId);
    try {
      const object = await upload.complete(parts);
      return { key: object.key, size: object.size, etag: object.httpEtag, customMetadata: object.customMetadata ?? {} };
    } catch (error) {
      // Completion may have succeeded before the client lost the response. In that case
      // the object is already strongly visible in R2 and finalization must remain idempotent.
      const object = await this.bucket.head(objectKey);
      if (object) return { key: object.key, size: object.size, etag: object.httpEtag, customMetadata: object.customMetadata ?? {} };
      throw error;
    }
  }

  async abort(objectKey: string, uploadId: string): Promise<void> {
    try {
      await this.bucket.resumeMultipartUpload(objectKey, uploadId).abort();
    } catch (error) {
      const existing = await this.bucket.head(objectKey);
      if (!existing) return;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    await this.bucket.delete(objectKey);
  }

  async read(objectKey: string, requestHeaders: Headers): Promise<VoiceReadResult | null> {
    const object = await this.bucket.get(objectKey, { range: requestHeaders });
    if (!object || !object.body) return null;

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, max-age=604800, immutable");
    headers.set("x-content-type-options", "nosniff");

    const range = object.range;
    if (requestHeaders.has("range") && range) {
      const resolved = resolveRange(range, object.size);
      if (resolved) {
        headers.set("content-range", `bytes ${resolved.start}-${resolved.end}/${object.size}`);
        headers.set("content-length", String(resolved.end - resolved.start + 1));
        headers.set("x-bulbam-range-status", "partial");
      }
    }

    return { body: object.body, headers };
  }
}

function resolveRange(
  range: { offset?: number; length?: number; suffix?: number },
  size: number
): { start: number; end: number } | null {
  if (range.offset != null) {
    const start = Math.max(0, range.offset);
    const length = range.length ?? Math.max(0, size - start);
    return { start, end: Math.min(size - 1, start + Math.max(0, length) - 1) };
  }
  if (range.suffix != null) {
    const length = Math.min(size, Math.max(0, range.suffix));
    return { start: Math.max(0, size - length), end: Math.max(0, size - 1) };
  }
  return null;
}
