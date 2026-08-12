export interface VoiceUploadSession {
  sessionId: string;
  conversationId: string;
  senderUserId: string;
  mimeType: string;
  bitrateBps: number;
  state: "uploading" | "ready";
  receivedParts: number[];
  sizeBytes: number;
  chunkCount: number;
}

export interface VoiceStoredObject {
  key: string;
  size: number;
  mimeType: string;
  bitrateBps: number;
  chunkCount: number;
}

export interface VoiceReadResult {
  body: ReadableStream<Uint8Array>;
  headers: Headers;
  status: number;
}

export interface VoiceStorage {
  initialize(): Promise<void>;
  create(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    mimeType: string,
    bitrateBps: number
  ): Promise<VoiceUploadSession>;
  inspect(sessionId: string, conversationId: string, senderUserId: string): Promise<VoiceUploadSession | null>;
  writeChunk(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    partNumber: number,
    bytes: Uint8Array
  ): Promise<{ duplicate: boolean; sizeBytes: number }>;
  complete(
    sessionId: string,
    conversationId: string,
    senderUserId: string,
    expectedChunkCount: number,
    expectedSizeBytes: number
  ): Promise<VoiceStoredObject>;
  abort(sessionId: string, conversationId: string, senderUserId: string): Promise<void>;
  delete(objectKey: string): Promise<void>;
  read(objectKey: string, requestHeaders: Headers): Promise<VoiceReadResult | null>;
}
