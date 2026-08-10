import type {
  Account,
  AccountCredentials,
  AccountRole,
  AuthenticatedSession,
  Invite,
  PublicAccount,
  Session
} from "../domain/models";

export type RegisterAccountResult =
  | { status: "created"; account: Account }
  | { status: "invite_invalid" }
  | { status: "username_taken" }
  | { status: "conflict" };

export interface IdentityRepository {
  initialize(): Promise<void>;

  findAccountCredentialsByUsername(username: string): Promise<AccountCredentials | null>;
  findPublicAccountById(userId: string): Promise<PublicAccount | null>;
  searchPublicAccounts(query: string, currentUserId: string, limit: number): Promise<PublicAccount[]>;

  registerAccountWithInvite(input: {
    userId: string;
    username: string;
    displayName: string;
    passwordHash: string;
    inviteCodeHash: string;
    now: number;
  }): Promise<RegisterAccountResult>;

  createSession(input: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    deviceName: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<Session>;

  findAuthenticatedSession(tokenHash: string, now: number): Promise<AuthenticatedSession | null>;
  touchSession(sessionId: string, now: number): Promise<void>;
  listSessions(userId: string, now: number): Promise<Session[]>;
  revokeSession(userId: string, sessionId: string, now: number): Promise<boolean>;

  createInvite(input: {
    inviteId: string;
    codeHash: string;
    createdByUserId: string | null;
    roleGrant: AccountRole;
    createdAt: number;
    expiresAt: number;
  }): Promise<Invite>;

  findUserIdsByUsernamePrefix(prefix: string): Promise<string[]>;
  deleteAccountsByUserIds(userIds: string[]): Promise<void>;
}
