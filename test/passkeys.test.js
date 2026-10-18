import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const server=createTestHarness({workers:[{configPath:"./wrangler.test.jsonc"}]});
beforeAll(async()=>server.listen());
afterEach(async()=>server.reset());
afterAll(async()=>server.close());
async function post(path,body,cookie){
 return server.fetch("https://bulbam-api.k69ysrndm7.workers.dev"+path,{method:"POST",headers:{"content-type":"application/json",...(cookie?{cookie}:{})},body:JSON.stringify(body)});
}
async function register() {
  await server.fetch("/api/ready");
  const env=await server.getWorker("bulbam-api-test").getEnv();
  const invite="BULBAM-PASSKEY-TEST-INVITATION-012345";
  await env.DB.prepare("INSERT INTO invites (invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)")
    .bind("passkeys-invite",createHash("sha256").update(invite).digest("hex"),"owner",Date.now()).run();
  const response=await post("/api/v1/auth/register",{username:"passkey_owner",displayName:"Passkeys",password:"test-passkey-password",inviteCode:invite,deviceName:"Test browser"});
  expect(response.status).toBe(201);
  const cookie="bulbam_session="+response.headers.get("set-cookie").match(/bulbam_session=([^;]+)/)[1];
  const account=(await response.json()).account;
  return {env,cookie,account};
}

describe("WebAuthn passkeys",()=>{
  test("registration and list require an authenticated session",async()=>{
    const {env,cookie,account}=await register();
    expect((await post("/api/v1/passkeys/registration/options",{})).status).toBe(401);
    expect((await server.fetch("/api/v1/passkeys")).status).toBe(401);
    const issued=await post("/api/v1/passkeys/registration/options",{},cookie);
    expect(issued.status).toBe(200);
    const registration=await issued.json();
    expect(registration.options.rp.name).toBe("Бульбам");
    expect(registration.options.authenticatorSelection.userVerification).toBe("required");
    expect(registration.options.authenticatorSelection.residentKey).toBe("required");
    expect(registration.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(registration.challengeId).toMatch(/^[a-f0-9-]{36}$/);
    const rows=await env.DB.prepare("SELECT user_id,session_id FROM passkey_challenges WHERE challenge_id=?")
      .bind(registration.challengeId).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].user_id).toBe(account.userId);
    expect((await server.fetch("/api/v1/passkeys",{headers:{cookie}})).status).toBe(200);
  });

  test("forged registration responses cannot create a key",async()=>{
    const {env,cookie}=await register();
    const begin=await post("/api/v1/passkeys/registration/options",{},cookie);
    const {challengeId}=await begin.json();
    const forged=await post("/api/v1/passkeys/registration/verify",{
      challengeId,response:{id:"fake",type:"public-key",rawId:"fake",response:{clientDataJSON:"",attestationObject:""}}
    },cookie);
    expect(forged.status).toBe(400);
    const keys=await env.DB.prepare("SELECT credential_id FROM account_passkeys").all();
    expect(keys.results).toHaveLength(0);
  });

  test("anonymous login has a 5-minute challenge and rejects a forged assertion",async()=>{
    const {env}=await register();
    const begin=await post("/api/v1/passkeys/authentication/options",{});
    expect(begin.status).toBe(200);
    const {challengeId,options}=await begin.json();
    expect(options.userVerification).toBe("required");
    expect(options.allowCredentials).toEqual([]);
    const row=await env.DB.prepare("SELECT purpose, expires_at FROM passkey_challenges WHERE challenge_id=?")
      .bind(challengeId).first();
    expect(row.purpose).toBe("login");
    expect(row.expires_at).toBeGreaterThan(Date.now());
    expect(row.expires_at).toBeLessThanOrEqual(Date.now()+300000);
    const forged=await post("/api/v1/passkeys/authentication/verify",{
      challengeId,response:{id:"fake",type:"public-key",rawId:"fake",
        response:{clientDataJSON:"fake",authenticatorData:"fake",signature:"fake"}}
    });
    expect(forged.status).toBe(400);
  });
});
