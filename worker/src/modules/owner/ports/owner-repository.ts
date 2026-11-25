import type { Account } from "../../identity/domain/models";
import type { OwnerManagedUserRecord } from "../domain/models";

export interface OwnerRepository {
  initialize(): Promise<void>;
  listAccountsWithSessionSummary(now: number): Promise<OwnerManagedUserRecord[]>;
  findAccountById(userId: string): Promise<Account | null>;
  restoreLatestSession(userId: string, now: number, newExpiresAt: number): Promise<{
    restored: boolean;
    deviceName: string | null;
  }>;
  revokeAllSessionsForUser(userId: string, now: number): Promise<number>;
  createOneTimeLoginToken(input: {
    tokenHash: string;
    userId: string;
    createdByUserId: string;
    now: number;
    expiresAt: number;
  }): Promise<void>;
  consumeOneTimeLoginToken(tokenHash: string, now: number): Promise<Account | null>;
  deleteAccountAndRecordNotice(input: {
    userId: string;
    usernameHash: string;
    reason: string;
    now: number;
  }): Promise<boolean>;
}
