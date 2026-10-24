import { createHash } from 'node:crypto';
import { beforeAll, afterAll, afterEach, test, expect } from 'vitest';
import { createTestHarness } from 'wrangler';
const server = createTestHarness({workers:[{configPath:'./wrangler.test.jsonc'}]});
beforeAll(async()=>{await server.listen();});
afterEach(async()=>{await server.reset();});
afterAll(async()=>{await server.close();});
async function register(n){await server.fetch('/api/ready');const env=await server.getWorker('bulbam-api-test').getEnv(); const inviteCode=`GROUPS-${n}-INVITE-2026`;const hash=createHash('sha256').update(inviteCode).digest('hex');await env.DB.prepare('INSERT INTO invites(invite_id,code_hash,created_by_user_id,role_grant,created_at,expires_at,used_at,used_by_user_id) VALUES(?,?,NULL,\'member\',?,NULL,NULL,NULL)').bind(`group-invite-${n}`,hash,Date.now()).run();const r=await server.fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:`grp_${n}`,displayName:n,password:'GroupTestStrongPassword2026!',inviteCode,deviceName:'Test'})});expect(r.status).toBe(201);return {cookie:`bulbam_session=${r.headers.get('set-cookie').match(/bulbam_session=([^;]+)/)[1]}`,id:(await r.json()).account.userId,name:n};}
const api=(path,user,method='GET',body)=>server.fetch(path,{method,headers:{cookie:user.cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
test('group creation, existing chats and new members, per-user read receipts and private history', async()=>{
 const [a,b,c,d]=await Promise.all([register('alpha'),register('beta'),register('gamma'),register('delta')]);
 let r=await api('/api/v1/chats/groups',a,'POST',{title:'Наши',historyMode:'since_join',userIds:[b.id,c.id]});if(r.status!==201)console.error('GROUP CREATE BODY',await r.clone().text());expect(r.status).toBe(201);const group=(await r.json()).chat;expect(group.kind).toBe('group');expect(group.title).toBe('Наши');
 for(const user of [a,b,c]){r=await api('/api/v1/chats',user);expect((await r.json()).chats.some(x=>x.conversationId===group.conversationId)).toBe(true);}expect((await (await api('/api/v1/chats',d)).json()).chats).toEqual([]);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,a,'POST',{clientMessageId:'group_hello_0001',text:'Привет всем'});expect(r.status).toBe(201);const m=(await r.json()).message;
 expect((await (await api(`/api/v1/chats/${group.conversationId}/messages`,d)).json()).ok).toBe(false);
 r=await api(`/api/v1/chats/${group.conversationId}/receipts/read`,b,'POST',{messageIds:[m.messageId]});expect(r.status).toBe(200);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,a);expect((await r.json()).messages[0].readBy).toEqual(expect.arrayContaining([expect.objectContaining({userId:b.id})]));
 r=await api(`/api/v1/chats/${group.conversationId}/members`,a,'POST',{userIds:[d.id]});expect(r.status).toBe(200);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,d);expect((await r.json()).messages).toEqual([]);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,d,'POST',{clientMessageId:'group_after_0002',text:'Я тут'});expect(r.status).toBe(201);
 r=await api(`/api/v1/chats/${group.conversationId}/members`,b,'POST',{userIds:[a.id]});expect(r.status).toBe(403);
});
