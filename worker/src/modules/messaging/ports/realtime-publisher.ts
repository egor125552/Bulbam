export interface RealtimePublisher {
  publishToUsers(userIds: string[], event: Record<string, unknown>): Promise<void>;
}
