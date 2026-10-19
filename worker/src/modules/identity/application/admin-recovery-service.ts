import { ApiError, forbidden } from "../../../core/errors";
import { hashPassword, sha256Hex } from "../../../core/crypto";
import type { D1Database } from "../../../platform/cloudflare";
import type { Account, AuthenticatedSession } from "../domain/models";
import { ensureIdentitySchema } from "../infrastructure/schema";
import type { IdentityService } from "./identity-service";
import type { PushNotificationService } from "../../notifications/application/push-notification-service";
import { DurableObjectRealtime } from "../../realtime/public";

const TTL = 24 * 60 * 60_000;
const APPROVAL_TTL = 15 * 60_000;
const MAX_REQUESTS_PER_DAY = 2;
type Row=Record<string,unknown>;
function invalid(): never {throw new ApiError(400,"invalid_recovery_request","Запрос восстановления недействителен или срок его действия истёк.");}
function isManager(auth:AuthenticatedSession):boolean {
  return auth.account.role === "owner" || auth.account.role === "admin";
}
function validateId(value:string):string {
  if(!/^[0-9a-f-]{36}$/i.test(value)) invalid();
  return value;
}
function token(): string {
  return "ar_" + Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,"0")).join("");
}
export class AdminRecoveryService {
  constructor(
    private readonly db:D1Database,
    private readonly identity:IdentityService,
    private readonly realtime:DurableObjectRealtime,
    private readonly push?:PushNotificationService,
    private readonly defer?:(job:Promise<unknown>)=>void
  ){}
  async request(username:string,deviceName:string,requester:string) {
    await ensureIdentitySchema(this.db);
    const now=Date.now();
    const requesterHash=await sha256Hex(requester.slice(0,128));
    const globalCount=await this.db.prepare(
      "SELECT COUNT(*) AS total FROM admin_recovery_requests WHERE requester_hash=? AND created_at>?"
    ).bind(requesterHash,now-TTL).first<{total:number}>();
    const row=await this.db.prepare(
      "SELECT user_id,role FROM accounts WHERE username=? COLLATE NOCASE AND disabled_at IS NULL LIMIT 1"
    ).bind(username).first<{user_id:string;role:string}>();
    const requestId=crypto.randomUUID(), secret=token();
    const verificationCode=Array.from(crypto.getRandomValues(new Uint8Array(6))).map(n=>String(n%10)).join("").slice(0,6);
    // Manager accounts may NOT be recovered by a second manager's approval alone.
    // Unknown accounts and ineligible accounts return the same generic payload.
    if(row?.role === "member" && Number(globalCount?.total??0)<8) {
      const recent=await this.db.prepare(
        "SELECT COUNT(*) AS total FROM admin_recovery_requests WHERE user_id=? AND created_at>?"
      ).bind(row.user_id,now-TTL).first<{total:number}>();
      const active=await this.db.prepare(
        "SELECT COUNT(*) AS total FROM admin_recovery_requests WHERE user_id=? AND status IN ('pending','approved') AND expires_at>?"
      ).bind(row.user_id,now).first<{total:number}>();
      if(Number(recent?.total??0)<MAX_REQUESTS_PER_DAY && Number(active?.total??0)===0){
        await this.db.prepare(`INSERT INTO admin_recovery_requests
          (request_id,user_id,secret_hash,device_name,requester_hash,verification_code,status,created_at,expires_at)
          VALUES (?,?,?,?,?,?,'pending',?,?)`
        ).bind(requestId,row.user_id,await sha256Hex(secret),deviceName,requesterHash,verificationCode,now,now+TTL).run();
        const owners=await this.db.prepare("SELECT user_id FROM accounts WHERE role='owner' AND disabled_at IS NULL").all<{user_id:string}>();
        const task=Promise.all((owners.results??[]).map(async owner=>{
          await Promise.all([
            this.realtime.publishToUsers([owner.user_id],{type:"admin.recovery.request"}),
            this.push?.notifyAdminRecoveryRequest(owner.user_id) ?? Promise.resolve()
          ]);
        })).catch(error=>console.warn("[AdminRecovery] notification failed",error));
        if(this.defer)this.defer(task);else await task;
      }
    }
    return {ok:true,requestId,secret,verificationCode,expiresAt:now+TTL,
      message:"Если аккаунт допускает восстановление, заявка передана администратору. Проверьте её статус на этом устройстве."};
  }

  async status(requestId:string, secret:string) {
    await ensureIdentitySchema(this.db);
    validateId(requestId);
    if(!/^ar_[a-f0-9]{64}$/.test(secret)) invalid();
    const row=await this.db.prepare(
      "SELECT status,expires_at,reviewed_at FROM admin_recovery_requests WHERE request_id=? AND secret_hash=?"
    ).bind(requestId,await sha256Hex(secret)).first<{status:string;expires_at:number;reviewed_at:number|null}>();
    // Unknown accounts don't leak existence: show pending until the generic request expires.
    if(!row)return {ok:true,status:"pending",expiresAt:Date.now()+TTL};
    if(row.expires_at<=Date.now())return {ok:true,status:"expired",expiresAt:row.expires_at};
    return {ok:true,status:row.status,expiresAt:row.expires_at};
  }

  async list(auth:AuthenticatedSession) {
    if(!isManager(auth))forbidden("admin_only","Просматривать заявки может только администратор.");
    await ensureIdentitySchema(this.db);
    const rows=await this.db.prepare(`SELECT r.request_id,r.device_name,r.verification_code,r.created_at,
      r.expires_at,a.username,a.display_name,a.role FROM admin_recovery_requests r
      JOIN accounts a ON a.user_id=r.user_id
      WHERE r.status='pending' AND r.expires_at>? AND a.disabled_at IS NULL
      ORDER BY r.created_at ASC LIMIT 30`
    ).bind(Date.now()).all<Row>();
    return (rows.results??[]).filter(row=>row.role==="member").map(row=>({
      requestId:String(row.request_id),username:String(row.username),
      displayName:String(row.display_name),deviceName:String(row.device_name),
      verificationCode:String(row.verification_code),createdAt:Number(row.created_at),expiresAt:Number(row.expires_at)
    }));
  }

  async decide(auth:AuthenticatedSession,requestId:string,approve:boolean,verifiedIdentity:boolean) {
    if(!isManager(auth))forbidden("admin_only","Рассматривать заявки может только администратор.");
    validateId(requestId);
    if(approve && !verifiedIdentity)
      throw new ApiError(400,"verification_required","Перед подтверждением проверьте личность владельца по заранее известному вам каналу.");
    const now=Date.now();
    const result=await this.db.prepare(`UPDATE admin_recovery_requests
      SET status=?, reviewed_at=?,reviewed_by=?,expires_at=?
      WHERE request_id=? AND status='pending' AND expires_at>?
      AND user_id IN (SELECT user_id FROM accounts WHERE role='member' AND disabled_at IS NULL)`
    ).bind(approve?"approved":"denied",now,auth.account.userId,approve?now+APPROVAL_TTL:now+TTL,requestId,now).run();
    if(result.meta?.changes!==1)invalid();
    return {ok:true};
  }

  async complete(requestId:string,secret:string,newPassword:string,deviceName:string) {
    await ensureIdentitySchema(this.db);
    validateId(requestId);
    if(!/^ar_[a-f0-9]{64}$/.test(secret))invalid();
    const secretHash=await sha256Hex(secret);
    const row=await this.db.prepare(`SELECT r.user_id FROM admin_recovery_requests r
      JOIN accounts a ON a.user_id=r.user_id
      WHERE r.request_id=? AND r.secret_hash=? AND r.status='approved'
        AND r.expires_at>? AND a.disabled_at IS NULL AND a.role='member'`
    ).bind(requestId,secretHash,Date.now()).first<{user_id:string}>();
    if(!row)invalid();
    const passwordHash=await hashPassword(newPassword);
    const now=Date.now(),nonce=crypto.randomUUID();
    // The entire batch is transactional: exactly one approved request can be consumed.
    const results=await this.db.batch([
      this.db.prepare(`UPDATE admin_recovery_requests SET status='consumed',consumed_at=?,consumed_nonce=?
        WHERE request_id=? AND status='approved' AND secret_hash=? AND expires_at>?`
      ).bind(now,nonce,requestId,secretHash,now),
      this.db.prepare(`UPDATE accounts SET password_hash=? WHERE user_id=? AND role='member'
        AND EXISTS(SELECT 1 FROM admin_recovery_requests WHERE request_id=? AND status='consumed' AND consumed_nonce=?)`
      ).bind(passwordHash,row.user_id,requestId,nonce),
      this.db.prepare(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM admin_recovery_requests WHERE request_id=? AND consumed_nonce=?)`
      ).bind(now,row.user_id,requestId,nonce),
      // Revoke all existing passkeys on admin-assisted recovery: an unknown
      // stolen key must not immediately take the account back after reset.
      this.db.prepare(`DELETE FROM account_passkeys WHERE user_id=?
        AND EXISTS(SELECT 1 FROM admin_recovery_requests WHERE request_id=? AND consumed_nonce=?)`
      ).bind(row.user_id,requestId,nonce)
    ]);
    if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1)invalid();
    const account=await this.db.prepare(`SELECT user_id,username,display_name,role,created_at
      FROM accounts WHERE user_id=? AND disabled_at IS NULL`).bind(row.user_id).first<Row>();
    if(!account)invalid();
    // A new session is issued only after a successful one-time password reset.
    const issued=await this.identity.loginWithPasskey({
      userId:String(account.user_id),username:String(account.username),
      displayName:String(account.display_name),role:"member",createdAt:Number(account.created_at)
    } as Account,deviceName);
    const recoveryCodes=await this.identity.issueRecoveryCodes(row.user_id);
    return {...issued,recoveryCodes};
  }
}
