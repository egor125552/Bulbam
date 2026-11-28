import type {
  DeliveryReceiptUpdate,
  DirectConversation,
  Conversation,
  FavoriteMessageEntry,
  GroupConversation,
  GroupMember,
  MessageReactionSummary,
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
  listAllConversationsForUser(userId: string, limit: number): Promise<Conversation[]>;
  findAnyConversationForUser(conversationId: string, userId: string): Promise<Conversation | null>;
  createGroup(title: string, avatarIcon: string, ownerUserId: string, members: string[], historyMode: "all" | "since_join", now: number): Promise<GroupConversation>;
  addGroupMembers(conversationId: string, userIds: string[], now: number): Promise<void>;
  removeGroupMember(conversationId: string, userId: string): Promise<void>;
  listGroupMembers(conversationId: string): Promise<GroupMember[]>;
  listMessageReaders(conversationId: string, messageIds: string[]): Promise<Map<string, Array<{ userId: string; readAt: number }>>>;
  listConversationRecipients(conversation: Conversation): Promise<string[]>;
  listMessages(conversationId: string, limit: number, viewerUserId: string): Promise<StoredMessage[]>;
  listMessagesByIds(conversationId: string, messageIds: string[], viewerUserId: string): Promise<Map<string, StoredMessage>>;
  insertMessage(input: StoredMessage): Promise<InsertMessageResult>;
  editMessage(conversationId: string, messageId: string, text: string, editedAt: number): Promise<boolean>;
  hideMessageForUser(conversationId: string, messageId: string, userId: string, now: number): Promise<boolean>;
  deleteMessageForEveryone(conversationId: string, messageId: string): Promise<boolean>;
  toggleReaction(messageId: string, userId: string, emoji: string, now: number): Promise<{ added: boolean; reactions: MessageReactionSummary[] }>;
  listReactionsForMessages(messageIds: string[], viewerUserId: string): Promise<Map<string, MessageReactionSummary[]>>;
  addFavorite(userId: string, conversationId: string, messageId: string, now: number): Promise<void>;
  removeFavorite(userId: string, messageId: string): Promise<void>;
  listFavoriteIds(userId: string, messageIds: string[]): Promise<Set<string>>;
  listFavorites(userId: string, limit: number): Promise<FavoriteMessageEntry[]>;
  markMessagesDelivered(
    conversationId: string,
    recipientUserId: string,
    messageIds: string[],
    now: number
  ): Promise<DeliveryReceiptUpdate[]>;
  markMessagesRead(
    conversationId: string,
    recipientUserId: string,
    messageIds: string[],
    now: number
  ): Promise<DeliveryReceiptUpdate[]>;
  findLatestMessage(conversationId: string, viewerUserId?: string): Promise<StoredMessage | null>;
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
  purgeDeletedUserData(input: {
    targetUserId: string;
    groupNoticeSenderFallbackUserId: string;
    groupNoticeBody: string;
    now: number;
  }): Promise<{
    removedDirectConversations: Array<{ conversationId: string; peerUserId: string }>;
    removedEmptyGroupIds: string[];
    updatedGroups: Array<{ conversationId: string; remainingMemberIds: string[]; noticeMessage?: StoredMessage }>;
  }>;
}
