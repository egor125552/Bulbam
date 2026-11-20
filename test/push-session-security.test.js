import {createHash} from "node:crypto";
import {afterAll,afterEach,beforeAll,expect,test} from "vitest";
import {createTestHarness} from "wrangler";
import {D1PushRepository} from "../worker/src/modules/notifications/infrastructure/d1-push-repository";
import {PresenceService} from "../worker/src/modules/presence/presence-service";
const server=createTestHarness({workers:[{configPath:"./wrangler.test.jsonc"}]});
beforeAll(()=>server.listen());
afterEach(()=>server.reset());
afterAll(()=>server.close());
const password="Bulbam-Push-Test-Password-2026!";
async function api(path,body={},cookie="",method="POST"){
 return server.fetch(path,{method,headers:{"content-type":"application/json",cookie},
 body:method==="GET"?undefined:JSON.stringify(body)});
}
function sessionCookie(response){
 const match=(response.headers.get("set-cookie")??"").match(/bulbam_session=([^;]+)/);
 if(!match)throw Error("Missing session cookie");
 return "bulbam_session="+match[1];
}
async function fixture(){
 expect((await server.fetch("/api/ready")).status).toBe(200);
 const env=await server.getWorker("bulbam-api-test").getEnv();
 const invite="BULBAM-PUSH-SESSION-TEST";
 await env.DB.prepare("INSERT INTO invites(invite_id,code_hash,role_grant,created_at) VALUES(?,?,?,?)")
 .bind("push-session",createHash("sha256").update(invite).digest("hex"),"member",Date.now()).run();
 const response=await api("/api/v1/auth/register",{
 username:"push_tester",displayName:"Пуш тест",password,inviteCode:invite,deviceName:"Device One"
 });
 expect(response.status).toBe(201);
 return {env,repo:new D1PushRepository(env.DB),presence:new PresenceService(env.DB),
 data:await response.clone().json(),cookie:sessionCookie(response)};
}
async function addPush(repo,userId,sessionId,n){
 await repo.upsert({endpoint:"https://push.example.org/device-"+n,userId,sessionId,
 expirationTime:null,keys:{p256dh:"abcdefghijkl",auth:"abcdefghij"},userAgent:"test"});
}
async function sessionId(cookie){
 const response=await api("/api/v1/auth/me",{},cookie,"GET");
 expect(response.status).toBe(200);
 return (await response.json()).session.sessionId;
}
test("logout deletes the device push and presence session",async()=>{
 const {data,cookie,env,repo,presence}=await fixture();
 const user=data.account.userId,id=data.session.sessionId;
 await addPush(repo,user,id,1);
 await presence.heartbeat({userId:user,sessionId:id},true);
 expect(await repo.listForUser(user)).toHaveLength(1);
 expect((await api("/api/v1/auth/logout",{},cookie)).status).toBe(200);
 expect(await repo.listForUser(user)).toHaveLength(0);
 const push=await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id=?").bind(user).all();
 const live=await env.DB.prepare("SELECT * FROM account_presence_sessions WHERE session_id=?").bind(id).all();
 expect(push.results).toEqual([]);
 expect(live.results).toEqual([]);
});
test("revoking one device preserves only the other device's push",async()=>{
 const {data,cookie,repo,presence,env}=await fixture(),user=data.account.userId;
 const login=await api("/api/v1/auth/login",{username:"push_tester",password,deviceName:"Device Two"});
 expect(login.status).toBe(200);
 const otherCookie=sessionCookie(login),otherId=await sessionId(otherCookie);
 await addPush(repo,user,data.session.sessionId,1);
 await addPush(repo,user,otherId,2);
 await presence.heartbeat({userId:user,sessionId:otherId},true);
 expect(await repo.listForUser(user)).toHaveLength(2);
 expect((await api("/api/v1/sessions/"+otherId,{},cookie,"DELETE")).status).toBe(200);
 expect((await repo.listForUser(user)).map(row=>row.sessionId)).toEqual([data.session.sessionId]);
 expect((await api("/api/v1/auth/me",{},otherCookie,"GET")).status).toBe(401);
 const rows=await env.DB.prepare("SELECT * FROM account_presence_sessions WHERE session_id=?").bind(otherId).all();
 expect(rows.results).toEqual([]);
});
test("password change invalidates other device push subscriptions",async()=>{
 const {data,cookie,repo}=await fixture();
 const login=await api("/api/v1/auth/login",{username:"push_tester",password,deviceName:"Second Device"});
 expect(login.status).toBe(200);
 const secondId=await sessionId(sessionCookie(login));
 await addPush(repo,data.account.userId,data.session.sessionId,1);
 await addPush(repo,data.account.userId,secondId,2);
 const changed=await api("/api/v1/auth/change-password",{newPassword:"AnotherValidPassword2026!"},cookie);
 expect(changed.status).toBe(200);
 expect((await repo.listForUser(data.account.userId)).map(item=>item.sessionId)).toEqual([data.session.sessionId]);
});
test("recovery revokes all old push subscriptions",async()=>{
 const {data,repo}=await fixture();
 await addPush(repo,data.account.userId,data.session.sessionId,1);
 const response=await api("/api/v1/auth/reset-with-recovery-code",{
 username:"push_tester",code:data.recoveryCodes[0],
 newPassword:"RecoveredPassword2026!",deviceName:"Recovered Device"});
 expect(response.status).toBe(200);
 expect(await repo.listForUser(data.account.userId)).toEqual([]);
});
