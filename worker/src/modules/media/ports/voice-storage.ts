import type { R2UploadedPart } from "../../../platform/cloudflare";

export interface VoiceStoredObject {
  key: string;
  size: number;
  etag: string;
  customMetadata: Record<string, string>;
}

export interface VoiceReadResult {
  body: ReadableStream;
  headers: Headers;
}

export interface VoiceStorage {
  create(objectKey: string, mimeType: string, bitrateBps: number): Promise<{ uploadId: string }>;
  uploadPart(objectKey: string, uploadId: string, partNumber: number, body: ReadableStream): Promise<R2UploadedPart>;
  complete(objectKey: string, uploadId: string, parts: R2UploadedPart[]): Promise<VoiceStoredObject>;
  abort(objectKey: string, uploadId: string): Promise<void>;
  delete(objectKey: string): Promise<void>;
  read(objectKey: string, requestHeaders: Headers): Promise<VoiceReadResult | null>;
}
