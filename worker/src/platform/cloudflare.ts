export type D1Value = string | number | null | ArrayBuffer | Uint8Array;

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: {
    changes?: number;
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  getByName(name: string): DurableObjectStub;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(socket: WebSocket): void;
  getWebSockets(): WebSocket[];
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  httpEtag: string;
  range?: { offset?: number; length?: number; suffix?: number };
  customMetadata?: Record<string, string>;
  body?: ReadableStream;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2MultipartUploadLike {
  key: string;
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob
  ): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(parts: R2UploadedPart[]): Promise<R2ObjectLike>;
}

export interface R2BucketLike {
  createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> }
  ): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string, options?: { range?: Headers }): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  ASSETS: AssetsBinding;
  DB?: D1Database;
  REALTIME?: DurableObjectNamespace;
  CALL_ROOM?: DurableObjectNamespace;
  VOICE_UPLOAD?: DurableObjectNamespace;
  VOICE_MEDIA?: R2BucketLike;
  DEBUG_ERRORS?: string;
  SMOKE_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  WEBRTC_STUN_URLS?: string;
  WEBRTC_EXTRA_STUN_URLS?: string;
  WEBRTC_TURN_URLS?: string;
  WEBRTC_TURN_SECRET?: string;
  WEBRTC_TURN_TTL_SECONDS?: string;
  WEBRTC_STATIC_TURN_URLS?: string;
  WEBRTC_STATIC_TURN_USERNAME?: string;
  WEBRTC_STATIC_TURN_CREDENTIAL?: string;
  WEBRTC_CLOUDFLARE_TURN_KEY_ID?: string;
  WEBRTC_CLOUDFLARE_TURN_API_TOKEN?: string;
}
