import { describe, expect, test } from "vitest";
import { IdentityService } from "../worker/src/modules/identity/application/identity-service";

class FakeIdentityRepository {
  constructor() {
    this.account = null;
    this.session = null;
    this.lastRegistration = null;
  }

  async initialize() {}

  async findAccountCredentialsByUsername() {
    return null;
  }

  async registerAccountWithInvite(input) {
    this.lastRegistration = input;
    this.account = {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      role: "member",
      createdAt: input.now
    };
    return { status: "created", account: this.account };
  }

  async createSession(input) {
    this.session = {
      sessionId: input.sessionId,
      userId: input.userId,
      deviceName: input.deviceName,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      lastSeenAt: input.createdAt,
      revokedAt: null
    };
    this.lastTokenHash = input.tokenHash;
    return this.session;
  }

  async findAuthenticatedSession() {
    return null;
  }

  async touchSession() {}
  async listSessions() { return []; }
  async revokeSession() { return true; }
  async createInvite() { throw new Error("not used"); }
}

describe("IdentityService", () => {
  test("registration creates stable ids, hashes secrets and issues a device session", async () => {
    const repository = new FakeIdentityRepository();
    const service = new IdentityService(repository);

    const result = await service.register({
      username: "egor",
      displayName: "Егор",
      password: "very-long-test-password",
      inviteCode: "BULBAM-TEST-INVITE-NOT-A-REAL-CODE",
      deviceName: "Web · test"
    });

    expect(result.account.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.session.userId).toBe(result.account.userId);
    expect(result.session.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.token).toMatch(/^bs_[0-9a-f]{64}$/);
    expect(repository.lastRegistration.passwordHash).not.toContain("very-long-test-password");
    expect(repository.lastRegistration.passwordHash).toMatch(/^PBKDF2-SHA256\$/);
    expect(repository.lastRegistration.inviteCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.lastRegistration.inviteCodeHash).not.toContain("BULBAM-TEST");
    expect(repository.lastTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.lastTokenHash).not.toBe(result.token);
  });
});
