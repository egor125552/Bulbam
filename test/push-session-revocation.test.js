import {createHash} from 'node:crypto';
import {afterAll,afterEach,beforeAll,expect,test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {D1PushRepository} from '../worker/src/modules/notifications/infrastructure/d1-push-repository';
import {PresenceService} from '../worker/src/modules/presence/presence-service';

const server=createTestHarness({workers:[{configPath:'./wrangler.test.jsonc'}]});
const password='Bulbam-Security-2026-Password!';
beforeAll(()=>server.listen());
afterEach(()=>server.reset());
afterAll(()=>server.close());
const json=async response=>response.json();
const cookie=response=>'bulbam_session='+response.headers.get('set-cookie').match(/bulbam_session=([^;]+)/)[1];
async function api(path,session,method='GET',body){
 const response=await server.fetch(path,{method,headers:{cookie:session,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {response,data:await json(response)};
}
async function register(){
 const worker=server.getWorker('bulbam-api-test');
 expect((await server.fetch('/api/ready')).status).toBe(200);
 const env=await worker.getEnv();
 const invite='BULBAM-SECURITY-SESSION-INVITE';
 await env.DB.prepare("INSERT INTO invites(invite_id,code_hash,role_grant,created_at) VALUES(?,?,'member',?)")
  .bind('secure-session-invite',createHash('sha256').update(invite).digest('hex'),Date.now()).run();
 const response=await server.fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'secure_user',displayName:'Защищённый пользователь',password,inviteCode:invite,deviceName:'Device one'})});
 expect(response.status).toBe(201);
 return {env,session:cookie(response),data:await json(response.clone())};
}
function subscribe(repo,userId,sessionId,which){
 return repo.upsert({endpoint:`https://push.example.test/${which}`,userId,sessionId,expirationTime:null,
   keys:{p256dh:'aaaaaaaaaaaa',auth:'bbbbbbbbbbbb'},userAgent:'test'});
}
async function secondLogin(){
 const response=await server.fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'secure_user',password,deviceName:'Device two'})});
 expect(response.status).toBe(200);
 return cookie(response);
}

test('revoking a single session removes its push and presence while retaining a trusted device',async()=>{
 const {env,session,data}=await register();
 const other=await secondLogin();
 const me1=(await api('/api/v1/auth/me',session)).data.session.sessionId;
 const me2=(await api('/api/v1/auth/me',other)).data.session.sessionId;
 const repo=new D1PushRepository(env.DB),presence=new PresenceService(env.DB);
 await subscribe(repo,data.account.userId,me1,'device-one');
 await subscribe(repo,data.account.userId,me2,'device-two');
 await presence.heartbeat({userId:data.account.userId,sessionId:me1},true);
 await presence.heartbeat({userId:data.account.userId,sessionId:me2},true);
 expect((await repo.listForUser(data.account.userId)).length).toBe(2);
 expect((await api(`/api/v1/sessions/${me1}`,other,'DELETE')).response.status).toBe(200);
 expect((await repo.listForUser(data.account.userId)).map(sub=>sub.sessionId)).toEqual([me2]);
 const stale=await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE session_id=?').bind(me1).first();
 expect(stale).toBeNull();
 expect(await env.DB.prepare('SELECT session_id FROM account_presence_sessions WHERE session_id=?').bind(me1).first()).toBeNull();
 expect((await api('/api/v1/auth/me',session)).response.status).toBe(401);
 expect((await api('/api/v1/auth/logout',other,'POST')).response.status).toBe(200);
 expect(await repo.listForUser(data.account.userId)).toEqual([]);
 expect(await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?').bind(data.account.userId).first()).toBeNull();
 expect(await env.DB.prepare('SELECT session_id FROM account_presence_sessions WHERE user_id=?').bind(data.account.userId).first()).toBeNull();
},20000);

test('password rotation revokes other push owners, without disabling the current device',async()=>{
 const {env,session,data}=await register();
 const other=await secondLogin();
 const me1=(await api('/api/v1/auth/me',session)).data.session.sessionId;
 const me2=(await api('/api/v1/auth/me',other)).data.session.sessionId;
 const repo=new D1PushRepository(env.DB);
 await subscribe(repo,data.account.userId,me1,'old');
 await subscribe(repo,data.account.userId,me2,'current');
 const changed=await api('/api/v1/auth/change-password',other,'POST',{newPassword:'Changed-Security-Password-2026!'});
 expect(changed.response.status).toBe(200);
 expect((await repo.listForUser(data.account.userId)).map(sub=>sub.sessionId)).toEqual([me2]);
 expect(await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE session_id=?').bind(me1).first()).toBeNull();
 expect((await api('/api/v1/auth/me',session)).response.status).toBe(401);
},20000);

test('recovery codes revoke all old device push subscriptions',async()=>{
 const {env,session,data}=await register();
 const other=await secondLogin();
 const me1=(await api('/api/v1/auth/me',session)).data.session.sessionId;
 const me2=(await api('/api/v1/auth/me',other)).data.session.sessionId;
 const repo=new D1PushRepository(env.DB);
 await subscribe(repo,data.account.userId,me1,'recovery-old-1');
 await subscribe(repo,data.account.userId,me2,'recovery-old-2');
 const recovery=await server.fetch('/api/v1/auth/reset-with-recovery-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'secure_user',code:data.recoveryCodes[0],newPassword:'Recovery-Security-Password-2026!',deviceName:'Recovered phone'})});
 expect(recovery.status).toBe(200);
 expect(await repo.listForUser(data.account.userId)).toEqual([]);
 expect(await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?').bind(data.account.userId).first()).toBeNull();
 expect((await api('/api/v1/auth/me',session)).response.status).toBe(401);
 expect((await api('/api/v1/auth/me',other)).response.status).toBe(401);
},25000);
