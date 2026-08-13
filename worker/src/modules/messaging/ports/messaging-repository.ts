import type {
  DeliveryReceiptUpdate,
  DirectConversation,
  StoredMessage,
  VoiceListenUpdate
} from "../domain/models";

export type InsertMessageResult =
  | { status: "created"; message: StoredMessage }
  | { status: "duplicate"; message: StoredMessage }
  | { status: "conflict" };

export interface MessagingRepository {
  initialize(): Promise<void>;
  getOrCreateDirectConversation(userId: string, peerUserId: string, now: number): Promise<DirectConversation>;
  findConversationForUser(conversationId: string, userId: string): Promise<DirectConversation | null>;
  listConversationsForUser(userId: string, limit: number): Promise<DirectConversation[]>;
  listMessages(conversationId: string, limit: number, viewerUserId: string): Promise<StoredMessage[]>;
  insertMessage(input: StoredMessage): Promise<InsertMessageResult>;
  markMessagesDelivered(
    conversationId: string,
    recipientUserId: string,
    messageIds: string[],
    now: number
  ): Promise<DeliveryReceiptUpdate[]>;
  findLatestMessage(conversationId: string): Promise<StoredMessage | null>;
  findMessageForUser(conversationId: string, messageId: string, userId: string): Promise<StoredMessage | null>;
  updateVoiceListening(
    conversationId: string,
    messageId: string,
    listenerUserId: string,
    heardRanges: Array<[number, number]>,
    resumeMs: number,
    completed: boolean,
    now: number
  ): Promise<VoiceListenUpdate | null>;
  getVoiceListeningShare(userId: string): Promise<boolean>;
  setVoiceListeningShare(userId: string, share: boolean, now: number): Promise<void>;
  deleteDataForUsers(userIds: string[]): Promise<void>;
}
