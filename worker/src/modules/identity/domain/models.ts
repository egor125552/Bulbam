export type AccountRole = "owner" | "admin" | "member";

export interface Account {
  userId: string;
  username: string;
  displayName: string;
  role: AccountRole;
  createdAt: number;
}

export interface AccountCredentials extends Account {
  passwordHash: string;
}

export interface Session {
  sessionId: string;
  userId: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface AuthenticatedSession {
  account: Account;
  session: Session;
}

export interface Invite {
  inviteId: string;
  roleGrant: AccountRole;
  createdByUserId: string | null;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
  usedByUserId: string | null;
}
