import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import type { D1Database } from "../../../platform/cloudflare";
import type { Account, AuthenticatedSession } from "../domain/models";
import { ApiError } from "../../../core/errors";
import { sha256Hex } from "../../../core/crypto";
import { ensureIdentitySchema } from "../infrastructure/schema";
import type { IdentityService } from "./identity-service";

const RP_ID = "bulbam-api.k69ysrndm7.workers.dev";
const RP_ORIGIN = "https://" + RP_ID;
const CHALLENGE_LIFETIME = 5 * 60_000;
type Row = Record<string, unknown>;
type Purpose = "login" | "register";

function invalid(): never {
  throw new ApiError(400, "invalid_passkey", "Не удалось проверить ключ доступа. Попробуйте ещё раз.");
}
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const result = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i=0; i<binary.length; i++) result[i]=binary.charCodeAt(i);
  return result;
}
function userHandle(userId: string): string {
  return encode(new TextEncoder().encode(userId));
}
function validateOrigin(origin: string): { rpID: string; origin: string } {
  if (origin === RP_ORIGIN) return { rpID: RP_ID, origin };
  // Browser localhost development only; arbitrary remote domains are forbidden.
  const parsed = new URL(origin);
  if (parsed.protocol === "http:" && parsed.hostname === "localhost")
    return {rpID:"localhost",origin};
  throw new ApiError(403, "untrusted_origin", "Этот адрес Бульбама не поддерживает ключи доступа.");
}
function accountFromRow(row: Row): Account {
  return {
    userId: String(row.user_id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role === "owner" || row.role === "admin" ? row.role : "member",
    createdAt: Number(row.created_at)
  };
}

export class PasskeyService {
  constructor(private readonly db: D1Database, private readonly identity: IdentityService) {}

  async list(userId: string) {
    await ensureIdentitySchema(this.db);
    const result = await this.db.prepare(
      "SELECT credential_id, name, created_at, last_used_at FROM account_passkeys WHERE user_id=? ORDER BY created_at DESC"
    ).bind(userId).all<Row>();
    return (result.results ?? []).map(row => ({
      id: String(row.credential_id),
      name: String(row.name),
      createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at)
    }));
  }

  async registrationOptions(auth: AuthenticatedSession, origin: string) {
    const {rpID} = validateOrigin(origin);
    await ensureIdentitySchema(this.db);
    const existing = await this.db.prepare(
      "SELECT credential_id, transports FROM account_passkeys WHERE user_id=?"
    ).bind(auth.account.userId).all<Row>();
    const options = await generateRegistrationOptions({
      rpName: "Бульбам",
      rpID,
      userName: auth.account.username,
      userDisplayName: auth.account.displayName,
      userID: new TextEncoder().encode(auth.account.userId),
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: (existing.results ?? []).map(row => ({
        id: String(row.credential_id),
        transports: JSON.parse(String(row.transports || "[]"))
      }))
    });
    const challengeId = crypto.randomUUID();
    const now = Date.now();
    await this.db.prepare(`INSERT INTO passkey_challenges
      (challenge_id, challenge, purpose, user_id, session_id, expires_at)
      VALUES (?,?, 'register', ?, ?, ?)`
    ).bind(challengeId, options.challenge, auth.account.userId, auth.session.sessionId, now + CHALLENGE_LIFETIME).run();
    return {challengeId, options};
  }

  async registrationFinish(auth: AuthenticatedSession, origin: string, input: {
    challengeId: string; response: RegistrationResponseJSON; name?: string;
  }) {
    const {rpID} = validateOrigin(origin);
    await ensureIdentitySchema(this.db);
    const challenge = await this.challenge(input.challengeId, "register");
    if (String(challenge.user_id) !== auth.account.userId ||
        String(challenge.session_id) !== auth.session.sessionId) invalid();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: String(challenge.challenge),
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true
      });
    } catch { invalid(); }
    if (!verification.verified || !verification.registrationInfo) invalid();
    const key = verification.registrationInfo.credential;
    if (!key || !key.id || !key.publicKey?.length) invalid();
    const now = Date.now();
    const name = String(input.name ?? "Ключ доступа").trim().slice(0, 80) || "Ключ доступа";
    const results = await this.db.batch([
      this.db.prepare(`UPDATE passkey_challenges SET used_at=?
        WHERE challenge_id=? AND used_at IS NULL AND expires_at > ? AND purpose='register'
          AND user_id=? AND session_id=?`
      ).bind(now, input.challengeId, now, auth.account.userId, auth.session.sessionId),
      this.db.prepare(`INSERT OR IGNORE INTO account_passkeys
        (credential_id,user_id,public_key,counter,transports,name,created_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS
          (SELECT 1 FROM passkey_challenges WHERE challenge_id=? AND used_at=?)`
      ).bind(key.id, auth.account.userId, encode(key.publicKey), key.counter,
        JSON.stringify(key.transports ?? []), name, now, input.challengeId, now)
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) invalid();
    return {ok:true};
  }

  async authenticationOptions(origin: string, requester: string) {
    const {rpID} = validateOrigin(origin);
    await ensureIdentitySchema(this.db);
    const hash = await sha256Hex(requester.slice(0, 100));
    const now = Date.now();
    // Anonymous begin endpoint must not be an unlimited write primitive.
    const count = await this.db.prepare(`SELECT COUNT(*) as total FROM passkey_challenges
      WHERE purpose='login' AND requester_hash=? AND expires_at > ?`)
      .bind(hash, now).first<{total:number}>();
    if (Number(count?.total ?? 0) >= 30)
      throw new ApiError(429, "rate_limited", "Слишком много попыток входа. Попробуйте позднее.");
    const options = await generateAuthenticationOptions({
      rpID, userVerification: "required", allowCredentials: []
    });
    const challengeId = crypto.randomUUID();
    await this.db.prepare(`INSERT INTO passkey_challenges
      (challenge_id, challenge, purpose, requester_hash, expires_at)
      VALUES (?,?,'login',?,?)`
    ).bind(challengeId,options.challenge,hash,now+CHALLENGE_LIFETIME).run();
    return {challengeId, options};
  }

  async authenticationFinish(origin:string,input:{
    challengeId:string; response:AuthenticationResponseJSON; deviceName:string
  }) {
    const {rpID}=validateOrigin(origin);
    await ensureIdentitySchema(this.db);
    const challenge=await this.challenge(input.challengeId,"login");
    const credentialId = input.response?.id;
    if (typeof credentialId !== "string" || credentialId.length > 1024) invalid();
    const row=await this.db.prepare(`SELECT p.*,a.username,a.display_name,a.role,a.created_at
      FROM account_passkeys p JOIN accounts a ON a.user_id=p.user_id
      WHERE p.credential_id=? AND a.disabled_at IS NULL LIMIT 1`)
      .bind(credentialId).first<Row>();
    if (!row) invalid();
    if (input.response.response?.userHandle && input.response.response.userHandle !== userHandle(String(row.user_id))) invalid();
    let verification;
    try {
      verification=await verifyAuthenticationResponse({
        response:input.response,
        expectedChallenge:String(challenge.challenge),
        expectedOrigin:origin,
        expectedRPID:rpID,
        requireUserVerification:true,
        credential: {
          id:String(row.credential_id),
          publicKey:decode(String(row.public_key)),
          counter:Number(row.counter),
          transports:JSON.parse(String(row.transports))
        }
      });
    } catch { invalid(); }
    if (!verification.verified) invalid();
    const now=Date.now();
    const results=await this.db.batch([
      this.db.prepare(`UPDATE passkey_challenges SET used_at=? WHERE challenge_id=?
        AND purpose='login' AND used_at IS NULL AND expires_at>?`)
        .bind(now,input.challengeId,now),
      this.db.prepare(`UPDATE account_passkeys SET counter=?, last_used_at=?
        WHERE credential_id=? AND counter=?`)
        .bind(verification.authenticationInfo.newCounter,now,credentialId,Number(row.counter))
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) invalid();
    return this.identity.loginWithPasskey(accountFromRow(row),input.deviceName);
  }

  async remove(userId:string, credentialId:string): Promise<boolean> {
    await ensureIdentitySchema(this.db);
    const result=await this.db.prepare("DELETE FROM account_passkeys WHERE user_id=? AND credential_id=?")
      .bind(userId,credentialId).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  private async challenge(challengeId:string, purpose:Purpose):Promise<Row> {
    if (!/^[a-f0-9-]{36}$/i.test(challengeId)) invalid();
    const result=await this.db.prepare(`SELECT * FROM passkey_challenges WHERE challenge_id=?
      AND purpose=? AND used_at IS NULL AND expires_at > ?`)
      .bind(challengeId,purpose,Date.now()).first<Row>();
    if (!result) invalid();
    return result;
  }
}
