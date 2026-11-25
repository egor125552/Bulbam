import type { AccountRole } from "../../identity/domain/models";

export interface OwnerManagedUserRecord {
  userId: string;
  username: string;
  displayName: string;
  role: AccountRole;
  createdAt: number;
  activeSessionsCount: number;
  restorableSessionsCount: number;
  lastSessionAt: number | null;
  lastDeviceName: string | null;
}

export interface OwnerManagedUser extends OwnerManagedUserRecord {
  online: boolean;
  lastActiveAt: number | null;
  presenceHidden: boolean;
  isSelf: boolean;
  canRestoreSession: boolean;
}

export interface OwnerRestoreSessionResult {
  restored: boolean;
  restoredSessionsCount: number;
  deviceName: string | null;
  expiresAt: number | null;
}

export interface OwnerLoginLinkResult {
  loginUrl: string;
  expiresAt: number;
}

export interface OwnerDeleteAccountResult {
  deletedUserId: string;
  username: string;
  reason: string;
  removedDirectChats: number;
  updatedGroups: number;
}
