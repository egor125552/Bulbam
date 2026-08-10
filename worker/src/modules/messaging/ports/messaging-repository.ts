import type { DeliveryReceiptUpdate, DirectConversation, StoredMessage } from "../domain/models";

export type InsertMessageResult =
  | { status: "created"; message: StoredMessage }
  | { status: "duplicate"; message: StoredMessage }
  | { status: "conflict" };

export interface MessagingRepository {
  initialize(): Promise<void>;
  getOrCreateDirectConversation(userId: string, peerUserId: string, now: number): Promise<DirectConversation>;
  findConversationForUser(conversationId: string, userId: string): Promise<DirectConversation | null>;
  listConversationsForUser(userId: string, limit: number): Promise<DirectConversation[]>;
  listMessages(conversationId: string, limit: number): Promise<StoredMessage[]>;
  insertMessage(input: StoredMessage): Promise<InsertMessageResult>;
  markMessagesDelivered(
    conversationId: string,
    recipientUserId: string,
    messageIds: string[],
    now: number
  ): Promise<DeliveryReceiptUpdate[]>;
  findLatestMessage(conversationId: string): Promise<StoredMessage | null>;
  deleteDataForUsers(userIds: string[]): Promise<void>;
}
