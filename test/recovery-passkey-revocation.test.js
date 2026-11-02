import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

const server=createTestHarness({workers:[{configPath:"./wrangler.test.jsonc"}]});
beforeAll(async()=>server.listen(),30000);
afterAll(async()=>server.close(),30000);
afterEach(async()=>server.reset());
async function post(url,body={},session){
  return server.fetch(url,{method:"POST",headers:{"content-type":"application/json",...(session?{cookie:session}:{})},body:JSON.stringify(body)});
}
async function register(username){
  await server.fetch("/api/ready");
  const env=await server.getWorker("bulbam-api-test").getEnv();
  const invite="BULBAM-SECURITY-TEST-"+username;
  await env.DB.prepare("INSERT INTO invites(invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)")
    .bind("invite-"+username,createHash("sha256").update(invite).digest("hex"),"member",Date.now()).run();
  const response=await post("/api/v1/auth/register",{username,displayName:username,password:"Original-password-2026!",inviteCode:invite,deviceName:"Original"});
  expect(response.status).toBe(201);
  const data=await response.json();
  const session="bulbam_session="+response.headers.get("set-cookie").match(/bulbam_session=([^;]+)/)[1];
  return {env,userId:data.account.userId,session,sessionId:data.session.sessionId,codes:data.recoveryCodes};
}
async function count(env,table,userId){
  const row=await env.DB.prepare("SELECT COUNT(*) AS amount FROM "+table+" WHERE user_id=?").bind(userId).first();
  return Number(row.amount);
}
async function plant(env,userId,sessionId,name){
  await env.DB.prepare(
    "INSERT INTO account_passkeys(credential_id,user_id,public_key,counter,transports,name,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind("key-"+name,userId,"AQID",0,"[]","Synthetic passkey",Date.now()).run();
  const challengeId=randomUUID();
  await env.DB.prepare(
    "INSERT INTO passkey_challenges(challenge_id,challenge,purpose,user_id,session_id,expires_at) VALUES (?,?,'register',?,?,?)"
  ).bind(challengeId,"synthetic-challenge",userId,sessionId,Date.now()+300000).run();
  return challengeId;
}
describe("recovery revokes persistent credentials",()=>{
  test("valid recovery removes both passkeys and enrollment challenges, invalid code changes nothing",async()=>{
    const alice=await register("recovery_alice");
    const bob=await register("recovery_bob");
    await plant(alice.env,alice.userId,alice.sessionId,"alice");
    await plant(alice.env,bob.userId,bob.sessionId,"bob");
    const wrong=await post("/api/v1/auth/reset-with-recovery-code",{username:"recovery_alice",
      code:"BRC-000000-000000-000000-000000",newPassword:"Recovered-password-2026!"});
    expect(wrong.status).toBe(400);
    expect(await count(alice.env,"account_passkeys",alice.userId)).toBe(1);
    expect(await count(alice.env,"passkey_challenges",alice.userId)).toBe(1);
    const valid=await post("/api/v1/auth/reset-with-recovery-code",{username:"recovery_alice",
      code:alice.codes[0],newPassword:"Recovered-password-2026!"});
    expect(valid.status).toBe(200);
    const recovered=await valid.json();
    expect(recovered.recoveryCodes).toHaveLength(8);
    expect(await count(alice.env,"account_passkeys",alice.userId)).toBe(0);
    expect(await count(alice.env,"passkey_challenges",alice.userId)).toBe(0);
    expect(await count(alice.env,"account_passkeys",bob.userId)).toBe(1);
    expect(await count(alice.env,"passkey_challenges",bob.userId)).toBe(1);
    expect((await server.fetch("/api/v1/auth/me",{headers:{cookie:alice.session}})).status).toBe(401);
    const newSession="bulbam_session="+valid.headers.get("set-cookie").match(/bulbam_session=([^;]+)/)[1];
    const list=await server.fetch("/api/v1/passkeys",{headers:{cookie:newSession}});
    expect(list.status).toBe(200);
    expect((await list.json()).passkeys).toEqual([]);
    const replay=await post("/api/v1/auth/reset-with-recovery-code",{username:"recovery_alice",
      code:alice.codes[0],newPassword:"Another-password-2026!"});
    expect(replay.status).toBe(400);
  });

  test("trusted-device password change also removes passkeys and registration challenges",async()=>{
    const alice=await register("change_password_alice");
    await plant(alice.env,alice.userId,alice.sessionId,"change-password");
    const changed=await post("/api/v1/auth/change-password",{newPassword:"New-strong-password-2026!"},alice.session);
    expect(changed.status).toBe(200);
    expect(await count(alice.env,"account_passkeys",alice.userId)).toBe(0);
    expect(await count(alice.env,"passkey_challenges",alice.userId)).toBe(0);
    expect((await server.fetch("/api/v1/auth/me",{headers:{cookie:alice.session}})).status).toBe(200);
  });
});
