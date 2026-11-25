import { sha256Hex } from "../../../core/crypto";
import { ApiError, forbidden } from "../../../core/errors";
import type { AuthenticatedSession } from "../../identity/domain/models";
import type { IdentityService } from "../../identity/application/identity-service";
import type { MessagingService } from "../../messaging/application/messaging-service";
import type { D1PushRepository } from "../../notifications/infrastructure/d1-push-repository";
import type { PresenceService } from "../../presence/presence-service";
import type { DurableObjectRealtime } from "../../realtime/public";
import type {
  OwnerDeleteAccountResult,
  OwnerLoginLinkResult,
  OwnerManagedUser,
  OwnerRestoreSessionResult
} from "../domain/models";
import type { OwnerRepository } from "../ports/owner-repository";

const RESTORED_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ONE_TIME_LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_REASON_LENGTH = 240;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function assertOwner(auth: AuthenticatedSession): void {
  if (auth.account.role !== "owner") {
    forbidden("owner_only", "Управление Бульбамом доступно только владельцу.");
  }
}

function validateUserId(userId: string): string {
  if (!UUID_RE.test(userId)) {
    throw new ApiError(400, "invalid_user_id", "Некорректный идентификатор пользователя.");
  }
  return userId;
}

function generateOneTimeLoginToken(): string {
  return (
    "ol_" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join("")
  );
}

export class OwnerControlService {
  constructor(
    private readonly repository: OwnerRepository,
    private readonly identity: IdentityService,
    private readonly messaging: MessagingService,
    private readonly presence: PresenceService,
    private readonly pushRepository: D1PushRepository,
    private readonly realtime: DurableObjectRealtime,
    private readonly defer?: (job: Promise<unknown>) => void
  ) {}

  async listUsers(auth: AuthenticatedSession): Promise<OwnerManagedUser[]> {
    assertOwner(auth);
    const now = Date.now();
    const [records, activityMap] = await Promise.all([
      this.repository.listAccountsWithSessionSummary(now),
      this.presence.listAllActivity()
    ]);

    return records.map((record) => {
      const activity = activityMap.get(record.userId);
      const lastActiveAt = activity?.lastActiveAt ?? record.lastSessionAt;
      return {
        ...record,
        online: Boolean(activity?.online && record.activeSessionsCount > 0),
        lastActiveAt,
        presenceHidden: Boolean(activity?.hidden),
        isSelf: record.userId === auth.account.userId,
        canRestoreSession: record.restorableSessionsCount > 0 || record.activeSessionsCount > 0
      };
    });
  }

  async restoreUserSession(
    auth: AuthenticatedSession,
    rawTargetUserId: string
  ): Promise<OwnerRestoreSessionResult> {
    assertOwner(auth);
    const targetUserId = validateUserId(rawTargetUserId);
    const target = await this.repository.findAccountById(targetUserId);
    if (!target) {
      throw new ApiError(404, "account_not_found", "Пользователь не найден.");
    }

    const now = Date.now();
    const expiresAt = now + RESTORED_SESSION_TTL_MS;
    const outcome = await this.repository.restoreLatestSession(targetUserId, now, expiresAt);

    this.notifyOwnerRefresh(auth.account.userId);

    return {
      restored: outcome.restored,
      restoredSessionsCount: outcome.restored ? 1 : 0,
      deviceName: outcome.deviceName,
      expiresAt: outcome.restored ? expiresAt : null
    };
  }

  async createOneTimeLoginLink(
    auth: AuthenticatedSession,
    rawTargetUserId: string,
    origin: string
  ): Promise<OwnerLoginLinkResult> {
    assertOwner(auth);
    const targetUserId = validateUserId(rawTargetUserId);
    const target = await this.repository.findAccountById(targetUserId);
    if (!target) {
      throw new ApiError(404, "account_not_found", "Пользователь не найден.");
    }
    if (target.role === "owner") {
      forbidden("cannot_target_owner", "Для аккаунта владельца одноразовая ссылка входа не создаётся.");
    }

    const rawToken = generateOneTimeLoginToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = Date.now();
    const expiresAt = now + ONE_TIME_LOGIN_TTL_MS;

    await this.repository.createOneTimeLoginToken({
      tokenHash,
      userId: target.userId,
      createdByUserId: auth.account.userId,
      now,
      expiresAt
    });

    const base = origin.replace(/\/$/, "");
    return {
      loginUrl: `${base}/?loginToken=${encodeURIComponent(rawToken)}`,
      expiresAt
    };
  }

  async redeemOneTimeLoginToken(rawToken: string, deviceName: string) {
    if (typeof rawToken !== "string" || !/^ol_[0-9a-f]{64}$/.test(rawToken)) {
      throw new ApiError(400, "invalid_login_token", "Ссылка для входа недействительна или уже использована.");
    }
    const tokenHash = await sha256Hex(rawToken);
    const account = await this.repository.consumeOneTimeLoginToken(tokenHash, Date.now());
    if (!account) {
      throw new ApiError(400, "invalid_login_token", "Ссылка для входа недействительна или срок её действия истёк.");
    }
    return this.identity.loginWithPasskey(account, deviceName);
  }

  async revokeUserSessions(
    auth: AuthenticatedSession,
    rawTargetUserId: string
  ): Promise<{ revokedCount: number }> {
    assertOwner(auth);
    const targetUserId = validateUserId(rawTargetUserId);
    if (targetUserId === auth.account.userId) {
      throw new ApiError(400, "cannot_revoke_self_here", "Свои сеансы можно завершить в разделе «Устройства».");
    }
    const target = await this.repository.findAccountById(targetUserId);
    if (!target) {
      throw new ApiError(404, "account_not_found", "Пользователь не найден.");
    }

    const revokedCount = await this.repository.revokeAllSessionsForUser(targetUserId, Date.now());
    await this.presence.removeForUser(targetUserId);

    const notify = Promise.all([
      this.realtime.publishToUsers([targetUserId], { type: "session.revoked" }),
      this.realtime.publishToUsers([auth.account.userId], { type: "owner.users.updated" })
    ]).catch((error) => console.warn("[OwnerControl] revoke notify failed", error));
    if (this.defer) this.defer(notify);
    else await notify;

    return { revokedCount };
  }

  async deleteUserCompletely(
    auth: AuthenticatedSession,
    rawTargetUserId: string,
    input: { confirmed: boolean; reason?: string }
  ): Promise<OwnerDeleteAccountResult> {
    assertOwner(auth);
    const targetUserId = validateUserId(rawTargetUserId);
    if (targetUserId === auth.account.userId) {
      throw new ApiError(400, "cannot_delete_self", "Нельзя удалить собственный аккаунт владельца.");
    }
    if (!input.confirmed) {
      throw new ApiError(400, "confirmation_required", "Подтвердите удаление пользователя флажком.");
    }

    const target = await this.repository.findAccountById(targetUserId);
    if (!target) {
      throw new ApiError(404, "account_not_found", "Пользователь не найден.");
    }
    if (target.role === "owner") {
      forbidden("cannot_delete_owner", "Нельзя удалить аккаунт владельца.");
    }

    const trimmedReason = String(input.reason ?? "").trim().slice(0, MAX_REASON_LENGTH);
    const reason = trimmedReason || "Аккаунт удалён владельцем.";

    // Notify the user in real time BEFORE wiping records so active tabs immediately
    // sign out and announce the deletion reason.
    await this.realtime
      .publishToUsers([target.userId], {
        type: "account.deleted",
        reason
      })
      .catch((error) => console.warn("[OwnerControl] account.deleted push failed", error));

    const messagingCleanup = await this.messaging.purgeDeletedUserAccount({
      targetUserId: target.userId,
      targetDisplayName: target.displayName,
      targetUsername: target.username,
      ownerUserId: auth.account.userId
    });

    await Promise.all([
      this.pushRepository.removeAllForUser(target.userId),
      this.presence.removeForUser(target.userId)
    ]);

    const usernameHash = await sha256Hex(target.username.toLowerCase());
    const deleted = await this.repository.deleteAccountAndRecordNotice({
      userId: target.userId,
      usernameHash,
      reason,
      now: Date.now()
    });
    if (!deleted) {
      throw new ApiError(404, "account_not_found", "Аккаунт уже удалён.");
    }

    this.notifyOwnerRefresh(auth.account.userId);

    return {
      deletedUserId: target.userId,
      username: target.username,
      reason,
      removedDirectChats: messagingCleanup.removedDirectChats,
      updatedGroups: messagingCleanup.updatedGroups
    };
  }

  private notifyOwnerRefresh(ownerUserId: string): void {
    const job = this.realtime
      .publishToUsers([ownerUserId], { type: "owner.users.updated" })
      .catch((error) => console.warn("[OwnerControl] owner refresh failed", error));
    if (this.defer) this.defer(job);
  }
}
