import type {DevicePublicKey,DeviceBundle, RegisteredDevice} from '../domain/device-key-validation';
import type {SealedDeviceEnvelope,StoredDeviceEnvelope} from '../domain/device-envelope';
import type {
  DeliveryReceiptUpdate,
  DirectConversation,
  Conversation,
  GroupConversation,
  GroupMember,
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
  protectDirectConversation(conversationId:string):Promise<void>;
  registerIdentityKey(userId:string,publicKey:string):Promise<boolean>;
  registerDevice(userId:string,bundle:DeviceBundle):Promise<RegisteredDevice|null>;
  listDevices(userId:string,includeInactive:boolean):Promise<RegisteredDevice[]>;
  approveDevice(userId:string,deviceId:string):Promise<boolean>;
  revokeDevice(userId:string,deviceId:string):Promise<boolean>;
  insertDeviceEnvelope(conversationId:string,senderUserId:string,envelope:SealedDeviceEnvelope,senderSigning:DevicePublicKey):Promise<{envelope:StoredDeviceEnvelope;created:boolean}>;
  listDeviceEnvelopes(conversationId:string,userId:string,deviceId:string):Promise<StoredDeviceEnvelope[]>;
  acknowledgeDeviceEnvelope(envelopeId:string,conversationId:string,userId:string,deviceId:string):Promise<boolean>;
  identityKeys(userIds:string[]):Promise<Map<string,string>>;
  activateAutoProtection(conversationId:string):Promise<boolean>;
  getFeatureEnabled(featureId:string):Promise<boolean>;
  setFeatureEnabled(featureId:string,enabled:boolean,actorId:string):Promise<void>;
  setDirectEncryptionOptOut(conversationId:string,enabled:boolean):Promise<void>;
  reactivateManualEncryption(conversationId:string):Promise<void>;
  listConversationsForUser(userId: string, limit: number): Promise<DirectConversation[]>;
  listAllConversationsForUser(userId: string, limit: number): Promise<Conversation[]>;
  findAnyConversationForUser(conversationId: string, userId: string): Promise<Conversation | null>;
  createGroup(title: string, avatarIcon: string, ownerUserId: string, members: string[], historyMode: "all" | "since_join", now: number): Promise<GroupConversation>;
  addGroupMembers(conversationId: string, userIds: string[], now: number): Promise<void>;
  removeGroupMember(conversationId:string,userId:string):Promise<void>;
  listGroupMembers(conversationId: string): Promise<GroupMember[]>;
  listMessageReaders(conversationId: string, messageIds: string[]): Promise<Map<string, Array<{userId:string;readAt:number}>>>;
  listConversationRecipients(conversation: Conversation): Promise<string[]>;
  listMessages(conversationId: string, limit: number, viewerUserId: string): Promise<StoredMessage[]>;
  insertMessage(input: StoredMessage): Promise<InsertMessageResult>;
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
