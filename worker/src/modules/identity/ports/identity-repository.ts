import type {
  Account,
  AccountCredentials,
  AccountRole,
  AuthenticatedSession,
  Invite,
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
    createdByUserId: string;
    roleGrant: AccountRole;
    createdAt: number;
    expiresAt: number;
  }): Promise<Invite>;
}
