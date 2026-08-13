export interface DirectConversation {
  conversationId: string;
  participantAId: string;
  participantBId: string;
  createdAt: number;
  lastMessageAt: number | null;
}

export interface VoiceListenProgress {
  listenedMs: number;
  resumeMs: number;
  completedAt: number | null;
  updatedAt: number;
  heardRanges?: Array<[number, number]>;
}

export interface VoiceAttachment {
  objectKey: string;
  durationMs: number;
  mimeType: string;
  bitrateBps: number;
  sizeBytes: number;
  progress: VoiceListenProgress | null;
}

export interface StoredMessage {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  clientMessageId: string;
  kind: "text" | "voice";
  text: string;
  voice: VoiceAttachment | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface DeliveryReceiptUpdate {
  message: StoredMessage;
  changed: boolean;
}

export interface VoiceListenUpdate {
  message: StoredMessage;
  progress: VoiceListenProgress;
}

export interface MessagingActor {
  userId: string;
}
