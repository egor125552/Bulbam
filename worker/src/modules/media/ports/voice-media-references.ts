export interface VoiceMediaReferences {
  listObjectKeysForUsers(userIds: string[]): Promise<string[]>;
}
