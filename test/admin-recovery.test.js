import {createHash} from "node:crypto";
import {beforeAll,afterAll,afterEach,describe,test,expect} from "vitest";
import {createTestHarness} from "wrangler";
const server=createTestHarness({workers:[{configPath:"./wrangler.test.jsonc"}]});
beforeAll(()=>server.listen());
afterEach(()=>server.reset());
afterAll(()=>server.close());
async function post(path,body={},cookie){
  return server.fetch(path,{method:"POST",headers:{"content-type":"application/json",...(cookie?{cookie}:{})},body:JSON.stringify(body)});
}
function sessionCookie(response){
  return "bulbam_session="+response.headers.get("set-cookie").match(/bulbam_session=([^;]+)/)[1];
}
async function users(){
  await server.fetch("/api/ready");
  const env=await server.getWorker("bulbam-api-test").getEnv();
  const invite="BULBAM-ADMIN-RECOVERY-OWNER-2026";
  await env.DB.prepare("INSERT INTO invites(invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)")
    .bind("admin-recovery-owner",createHash("sha256").update(invite).digest("hex"),"owner",Date.now()).run();
  const ownerResponse=await post("/api/v1/auth/register",{
    username:"recovery_admin",displayName:"Администратор",password:"test-password-owner",inviteCode:invite
  });
  expect(ownerResponse.status).toBe(201);
  const owner=sessionCookie(ownerResponse);
  const newInvite=await post("/api/v1/invites",{expiresInHours:24},owner);
  expect(newInvite.status).toBe(201);
  const info=await newInvite.json();
  const memberResponse=await post("/api/v1/auth/register",{
    username:"recovery_member",displayName:"Участник",password:"test-password-member",inviteCode:info.code
  });
  expect(memberResponse.status).toBe(201);
  const member=sessionCookie(memberResponse);
  return {owner,member,env};
}
describe("administrator-assisted account recovery",()=>{
  test("an unknown username is not enumerable and owner accounts cannot be approved",async()=>{
    const {owner}=await users();
    const fake=await post("/api/v1/auth/admin-recovery/request",{username:"no_such_user"});
    const own=await post("/api/v1/auth/admin-recovery/request",{username:"recovery_admin"});
    expect(fake.status).toBe(200);
    expect(own.status).toBe(200);
    const requests=await server.fetch("/api/v1/admin/recovery-requests",{headers:{cookie:owner}});
    expect((await requests.json()).requests).toEqual([]);
  });
  test("only admins can approve, proof-of-identity checkbox is mandatory",async()=>{
    const {owner,member}=await users();
    const request=await post("/api/v1/auth/admin-recovery/request",{
      username:"recovery_member",deviceName:"iPhone"
    });
    expect(request.status).toBe(200);
    const {requestId,secret}=await request.json();
    const status=await post("/api/v1/auth/admin-recovery/status",{requestId,secret});
    expect((await status.json()).status).toBe("pending");
    const url="/api/v1/admin/recovery-requests/"+requestId+"/decision";
    expect((await server.fetch("/api/v1/admin/recovery-requests")).status).toBe(401);
    expect((await server.fetch("/api/v1/admin/recovery-requests",{headers:{cookie:member}})).status).toBe(403);
    expect((await post(url,{approve:true,verifiedIdentity:true},member)).status).toBe(403);
    expect((await post(url,{approve:true,verifiedIdentity:false},owner)).status).toBe(400);
    const approval=await post(url,{approve:true,verifiedIdentity:true},owner);
    expect(approval.status).toBe(200);
    const approved=await post("/api/v1/auth/admin-recovery/status",{requestId,secret});
    expect((await approved.json()).status).toBe("approved");
    expect((await post(url,{approve:true,verifiedIdentity:true},owner)).status).toBe(400);
  });
  test("approval allows one-time password reset and revokes old sessions",async()=>{
    const {owner,member}=await users();
    const application=await post("/api/v1/auth/admin-recovery/request",{
      username:"recovery_member",deviceName:"Android"
    });
    const {requestId,secret}=await application.json();
    expect((await post("/api/v1/admin/recovery-requests/"+requestId+"/decision",{
      approve:true,verifiedIdentity:true
    },owner)).status).toBe(200);
    const password="an-entirely-new-password-2026";
    const completed=await post("/api/v1/auth/admin-recovery/complete",{
      requestId,secret,newPassword:password,deviceName:"Android"
    });
    expect(completed.status).toBe(200);
    const data=await completed.json();
    expect(data.account.username).toBe("recovery_member");
    expect(data.recoveryCodes).toHaveLength(8);
    expect((await server.fetch("/api/v1/auth/me",{headers:{cookie:member}})).status).toBe(401);
    expect((await post("/api/v1/auth/login",{username:"recovery_member",password:"test-password-member"})).status).toBe(401);
    expect((await post("/api/v1/auth/login",{username:"recovery_member",password})).status).toBe(200);
    expect((await post("/api/v1/auth/admin-recovery/complete",{
      requestId,secret,newPassword:"another-new-password-2026"
    })).status).toBe(400);
    const wrongSecret=await post("/api/v1/auth/admin-recovery/status",{
      requestId,secret:"ar_"+"0".repeat(64)
    });
    expect((await wrongSecret.json()).status).toBe("pending");
  });
  test("denied requests cannot change passwords",async()=>{
    const {owner}=await users();
    const {requestId,secret}=await (await post("/api/v1/auth/admin-recovery/request",{username:"recovery_member"})).json();
    expect((await post("/api/v1/admin/recovery-requests/"+requestId+"/decision",{
      approve:false,verifiedIdentity:false
    },owner)).status).toBe(200);
    const denied=await post("/api/v1/auth/admin-recovery/status",{requestId,secret});
    expect((await denied.json()).status).toBe("denied");
    expect((await post("/api/v1/auth/admin-recovery/complete",{
      requestId,secret,newPassword:"another-new-password-2026"
    })).status).toBe(400);
  });
});
