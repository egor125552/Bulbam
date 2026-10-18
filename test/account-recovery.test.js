import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const server = createTestHarness({ workers: [{ configPath: "./wrangler.test.jsonc" }] });
const INVITE = "BULBAM-RECOVERY-INTEGRATION-OWNER";
const OLD_PASSWORD = "Bulbam-integration-password-old";
const NEW_PASSWORD = "Bulbam-integration-password-new";

beforeAll(async () => server.listen());
afterEach(async () => server.reset());
afterAll(async () => server.close());

async function request(path, body, cookie) {
  return server.fetch(path, {
    method:"POST",
    headers: { "content-type":"application/json", ...(cookie ? {cookie} : {}) },
    body:JSON.stringify(body)
  });
}

function cookie(response) {
  const value = response.headers.get("set-cookie") ?? "";
  const match = value.match(/bulbam_session=([^;]+)/);
  if (!match) throw new Error("Missing session cookie");
  return "bulbam_session=" + match[1];
}

async function register() {
  await server.fetch("/api/ready");
  const worker=server.getWorker("bulbam-api-test");
  const env=await worker.getEnv();
  await env.DB.prepare("INSERT INTO invites (invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)")
    .bind("recovery-owner",createHash("sha256").update(INVITE).digest("hex"),"owner",Date.now()).run();
  const response=await request("/api/v1/auth/register",{
    username:"recovery_owner",displayName:"Владелец",password:OLD_PASSWORD,inviteCode:INVITE,deviceName:"First device"
  });
  expect(response.status).toBe(201);
  return {data:await response.json(),session:cookie(response),env};
}

describe("account recovery",()=>{
  test("provides one-time recovery codes at registration without storing raw codes",async()=>{
    const {data,env}=await register();
    expect(data.recoveryCodes).toHaveLength(8);
    expect(new Set(data.recoveryCodes).size).toBe(8);
    for(const code of data.recoveryCodes) expect(code).toMatch(/^BRC-[0-9A-F]{6}(?:-[0-9A-F]{6}){3}$/);
    const saved=await env.DB.prepare("SELECT code_hash FROM password_recovery_codes WHERE user_id=?").bind(data.account.userId).all();
    expect(saved.results).toHaveLength(8);
    expect(saved.results.some(row=>data.recoveryCodes.includes(row.code_hash))).toBe(false);
  });

  test("a recovery code resets the password once, revokes old sessions and preserves account",async()=>{
    const {data,session}=await register();
    const wrong=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"recovery_owner",code:"BRC-000000-000000-000000-000000",newPassword:NEW_PASSWORD
    });
    expect(wrong.status).toBe(400);
    const response=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"recovery_owner",code:data.recoveryCodes[0],newPassword:NEW_PASSWORD
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect((await server.fetch("/api/v1/auth/me",{headers:{cookie:session}})).status).toBe(401);
    const reused=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"recovery_owner",code:data.recoveryCodes[0],newPassword:OLD_PASSWORD
    });
    expect(reused.status).toBe(400);
    const otherCode=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"recovery_owner",code:data.recoveryCodes[1],newPassword:OLD_PASSWORD
    });
    expect(otherCode.status).toBe(400);
    const wrongLogin=await request("/api/v1/auth/login",{username:"recovery_owner",password:OLD_PASSWORD});
    expect(wrongLogin.status).toBe(401);
    const login=await request("/api/v1/auth/login",{
      username:"recovery_owner",password:NEW_PASSWORD,deviceName:"Recovered device"
    });
    expect(login.status).toBe(200);
    expect((await login.json()).account.userId).toBe(data.account.userId);
  });

  test("a still signed-in trusted device can rotate password and recovery codes",async()=>{
    const {data,session}=await register();
    const rotated=await request("/api/v1/auth/recovery-codes",{},{cookie:session});
    expect(rotated.status).toBe(200);
    const codes=(await rotated.json()).recoveryCodes;
    expect(codes).toHaveLength(8);
    expect(codes[0]).not.toBe(data.recoveryCodes[0]);
    const oldReset=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"recovery_owner",code:data.recoveryCodes[0],newPassword:NEW_PASSWORD
    });
    expect(oldReset.status).toBe(400);
    const change=await request("/api/v1/auth/change-password",{newPassword:NEW_PASSWORD},{cookie:session});
    expect(change.status).toBe(200);
    expect((await server.fetch("/api/v1/auth/me",{headers:{cookie:session}})).status).toBe(200);
    const reused=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"recovery_owner",code:codes[0],newPassword:OLD_PASSWORD
    });
    expect(reused.status).toBe(400);
    expect((await request("/api/v1/auth/login",{username:"recovery_owner",password:NEW_PASSWORD})).status).toBe(200);
  });

  test("requires either a current session or valid recovery code to change password",async()=>{
    const {data}=await register();
    const anonymous=await request("/api/v1/auth/change-password",{newPassword:NEW_PASSWORD});
    expect(anonymous.status).toBe(401);
    const mismatch=await request("/api/v1/auth/reset-with-recovery-code",{
      username:"another_account",code:data.recoveryCodes[0],newPassword:NEW_PASSWORD
    });
    expect(mismatch.status).toBe(400);
  });
});
