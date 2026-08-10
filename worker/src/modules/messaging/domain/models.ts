export interface DirectConversation {
  conversationId: string;
  participantAId: string;
  participantBId: string;
  createdAt: number;
  lastMessageAt: number | null;
}

export interface StoredMessage {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  clientMessageId: string;
  text: string;
  createdAt: number;
  deliveredAt: number | null;
}

export interface DeliveryReceiptUpdate {
  message: StoredMessage;
  changed: boolean;
}

export interface MessagingActor {
  userId: string;
}
