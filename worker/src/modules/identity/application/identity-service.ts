import {
  hashPassword,
  newInviteCode,
  newSessionToken,
  sha256Hex,
  verifyPassword
} from "../../../core/crypto";
import { ApiError, conflict, forbidden, unauthorized } from "../../../core/errors";
import type { AuthenticatedSession, PublicAccount, Session } from "../domain/models";
import { validateUserSearchQuery } from "../domain/validation";
import type { IdentityRepository } from "../ports/identity-repository";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SMOKE_INVITE_TTL_MS = 30 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  "PBKDF2-SHA256$100000$00112233445566778899aabbccddeeff$7fade2cfb29dccfed77a3157d406da9087ffe3ebd4d722ed8657c1816197f326";

export class IdentityService {
  constructor(private readonly repository: IdentityRepository) {}

  async register(input: {
    username: string;
    displayName: string;
    password: string;
    inviteCode: string;
    deviceName: string;
  }) {
    await this.repository.initialize();
    const now = Date.now();
    const passwordHash = await hashPassword(input.password);
    const inviteCodeHash = await sha256Hex(input.inviteCode);
    const userId = crypto.randomUUID();

    const result = await this.repository.registerAccountWithInvite({
      userId,
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      inviteCodeHash,
      now
    });

    if (result.status === "invite_invalid") {
      throw new ApiError(400, "invite_invalid", "Приглашение недействительно или уже использовано.");
    }
    if (result.status === "username_taken") {
      conflict("username_taken", "Этот username уже занят.");
    }
    if (result.status !== "created") {
      conflict("registration_conflict", "Регистрацию не удалось завершить. Повтори попытку.");
    }

    const issued = await this.issueSession(result.account.userId, input.deviceName, now);
    return { account: result.account, ...issued };
  }

  async login(input: { username: string; password: string; deviceName: string }) {
    await this.repository.initialize();
    const credentials = await this.repository.findAccountCredentialsByUsername(input.username);
    const passwordMatches = await verifyPassword(
      input.password,
      credentials?.passwordHash ?? DUMMY_PASSWORD_HASH
    );

    if (!credentials || !passwordMatches) {
      unauthorized("invalid_credentials", "Неверный username или пароль.");
    }

    const issued = await this.issueSession(credentials.userId, input.deviceName, Date.now());
    const { passwordHash: _passwordHash, ...account } = credentials;
    return { account, ...issued };
  }

  async authenticate(token: string | null): Promise<AuthenticatedSession> {
    if (!token || !/^bs_[0-9a-f]{64}$/.test(token)) {
      unauthorized("invalid_session", "Сессия недействительна.");
    }

    await this.repository.initialize();
    const now = Date.now();
    const tokenHash = await sha256Hex(token);
    const authenticated = await this.repository.findAuthenticatedSession(tokenHash, now);
    if (!authenticated) {
      unauthorized("invalid_session", "Сессия истекла или была завершена.");
    }

    if (now - authenticated.session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      await this.repository.touchSession(authenticated.session.sessionId, now);
      authenticated.session.lastSeenAt = now;
    }
    return authenticated;
  }

  async logout(authenticated: AuthenticatedSession): Promise<void> {
    await this.repository.revokeSession(
      authenticated.account.userId,
      authenticated.session.sessionId,
      Date.now()
    );
  }

  async listSessions(authenticated: AuthenticatedSession): Promise<Session[]> {
    return this.repository.listSessions(authenticated.account.userId, Date.now());
  }

  async revokeSession(authenticated: AuthenticatedSession, sessionId: string): Promise<void> {
    const revoked = await this.repository.revokeSession(
      authenticated.account.userId,
      sessionId,
      Date.now()
    );
    if (!revoked) {
      throw new ApiError(404, "session_not_found", "Сессия не найдена.");
    }
  }

  async searchUsers(authenticated: AuthenticatedSession, rawQuery: string): Promise<PublicAccount[]> {
    const query = validateUserSearchQuery(rawQuery);
    return this.repository.searchPublicAccounts(query, authenticated.account.userId, 20);
  }

  async findPublicAccountById(userId: string): Promise<PublicAccount | null> {
    return this.repository.findPublicAccountById(userId);
  }

  async createInvite(authenticated: AuthenticatedSession, expiresInHours?: number) {
    if (authenticated.account.role !== "owner" && authenticated.account.role !== "admin") {
      forbidden("invite_permission_denied", "Создавать приглашения может только администратор.");
    }

    const requestedTtl =
      typeof expiresInHours === "number" && Number.isFinite(expiresInHours)
        ? Math.round(expiresInHours * 60 * 60 * 1000)
        : DEFAULT_INVITE_TTL_MS;
    const ttl = Math.max(60 * 60 * 1000, Math.min(MAX_INVITE_TTL_MS, requestedTtl));
    return this.issueInvite(authenticated.account.userId, ttl);
  }

  async createSmokeInvite() {
    return this.issueInvite(null, SMOKE_INVITE_TTL_MS);
  }

  async findSmokeUserIds(prefix: string): Promise<string[]> {
    if (!/^smoke_[a-z0-9_]+$/i.test(prefix)) {
      throw new ApiError(400, "invalid_smoke_prefix", "Некорректный smoke-префикс.");
    }
    return this.repository.findUserIdsByUsernamePrefix(prefix);
  }

  async deleteUsersByIds(userIds: string[]): Promise<void> {
    await this.repository.deleteAccountsByUserIds(userIds);
  }

  private async issueInvite(createdByUserId: string | null, ttl: number) {
    const now = Date.now();
    const code = newInviteCode();
    const codeHash = await sha256Hex(code);
    const invite = await this.repository.createInvite({
      inviteId: crypto.randomUUID(),
      codeHash,
      createdByUserId,
      roleGrant: "member",
      createdAt: now,
      expiresAt: now + ttl
    });
    return { invite, code };
  }

  private async issueSession(userId: string, deviceName: string, now: number) {
    const token = newSessionToken();
    const tokenHash = await sha256Hex(token);
    const session = await this.repository.createSession({
      sessionId: crypto.randomUUID(),
      userId,
      tokenHash,
      deviceName,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    });
    return { session, token };
  }
}
