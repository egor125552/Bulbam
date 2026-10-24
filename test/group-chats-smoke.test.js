import { createHash } from 'node:crypto';
import { beforeAll, afterAll, afterEach, test, expect } from 'vitest';
import { createTestHarness } from 'wrangler';
const server = createTestHarness({workers:[{configPath:'./wrangler.test.jsonc'}]});
beforeAll(async()=>{await server.listen();});
afterEach(async()=>{await server.reset();});
afterAll(async()=>{await server.close();});
async function register(n){await server.fetch('/api/ready');const env=await server.getWorker('bulbam-api-test').getEnv(); const inviteCode=`GROUPS-${n}-INVITE-2026`;const hash=createHash('sha256').update(inviteCode).digest('hex');await env.DB.prepare('INSERT INTO invites(invite_id,code_hash,created_by_user_id,role_grant,created_at,expires_at,used_at,used_by_user_id) VALUES(?,?,NULL,\'member\',?,NULL,NULL,NULL)').bind(`group-invite-${n}`,hash,Date.now()).run();const r=await server.fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:`grp_${n}`,displayName:n,password:'GroupTestStrongPassword2026!',inviteCode,deviceName:'Test'})});expect(r.status).toBe(201);return {cookie:`bulbam_session=${r.headers.get('set-cookie').match(/bulbam_session=([^;]+)/)[1]}`,id:(await r.json()).account.userId,name:n};}
const api=(path,user,method='GET',body,extraHeaders={})=>server.fetch(path,{method,headers:{cookie:user.cookie,...(body?{'content-type':'application/json'}:{}),...extraHeaders},body:body?JSON.stringify(body):undefined});
test('group creation, existing chats and new members, per-user read receipts and private history', async()=>{
 const [a,b,c,d]=await Promise.all([register('alpha'),register('beta'),register('gamma'),register('delta')]);
 let r=await api('/api/v1/chats/groups',a,'POST',{title:'Наши',historyMode:'since_join',userIds:[b.id,c.id]});expect(r.status).toBe(201);const group=(await r.json()).chat;expect(group.kind).toBe('group');expect(group.title).toBe('Наши');
 for(const user of [a,b,c]){r=await api('/api/v1/chats',user);expect((await r.json()).chats.some(x=>x.conversationId===group.conversationId)).toBe(true);}expect((await (await api('/api/v1/chats',d)).json()).chats).toEqual([]);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,a,'POST',{clientMessageId:'group_hello_0001',text:'Привет всем'});expect(r.status).toBe(201);const m=(await r.json()).message;
 expect((await (await api(`/api/v1/chats/${group.conversationId}/messages`,d)).json()).ok).toBe(false);
 r=await api(`/api/v1/chats/${group.conversationId}/receipts/read`,b,'POST',{messageIds:[m.messageId]});expect(r.status).toBe(200);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,a);expect((await r.json()).messages[0].readBy).toEqual(expect.arrayContaining([expect.objectContaining({userId:b.id})]));
 expect((await (await api(`/api/v1/chats/${group.conversationId}/messages`,c)).json()).messages[0].readAt).toBeNull();
 expect((await api(`/api/v1/chats/${group.conversationId}/receipts/read`,c,'POST',{messageIds:[m.messageId]})).status).toBe(200);
 expect((await (await api(`/api/v1/chats/${group.conversationId}/messages`,a)).json()).messages[0].readBy).toHaveLength(2);
 r=await api(`/api/v1/chats/${group.conversationId}/members`,a,'POST',{userIds:[d.id]});expect(r.status).toBe(200);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,d);expect((await r.json()).messages).toEqual([]);
 expect((await api(`/api/v1/chats/${group.conversationId}/receipts/read`,d,'POST',{messageIds:[m.messageId]})).status).toBe(400);
 r=await api(`/api/v1/chats/${group.conversationId}/messages`,d,'POST',{clientMessageId:'group_after_0002',text:'Я тут'});expect(r.status).toBe(201);
 r=await api(`/api/v1/chats/${group.conversationId}/members`,b,'POST',{userIds:[a.id]});expect(r.status).toBe(403);
 expect((await api(`/api/v1/chats/${group.conversationId}/members/${c.id}`,b,'DELETE')).status).toBe(403);
 expect((await api(`/api/v1/chats/${group.conversationId}/members/${a.id}`,a,'DELETE')).status).toBe(400);
 expect((await api(`/api/v1/chats/${group.conversationId}/members/${d.id}`,d,'DELETE')).status).toBe(200);
 expect((await api(`/api/v1/chats/${group.conversationId}/messages`,d)).status).toBe(404);
});

test('full history option allows later participants to read prior messages',async()=>{
 const [a,b,c]=await Promise.all([register('alpha'),register('beta'),register('gamma')]);
 const create=await api('/api/v1/chats/groups',a,'POST',{title:'История',avatarIcon:'🏠',historyMode:'all',userIds:[b.id]});
 expect(create.status).toBe(201);
 const group=(await create.json()).chat;
 const send=await api(`/api/v1/chats/${group.conversationId}/messages`,a,'POST',{clientMessageId:'group_history_0001',text:'Вчерашние новости'});
 expect(send.status).toBe(201);
 const message=(await send.json()).message;
 expect((await api(`/api/v1/chats/${group.conversationId}/members`,a,'POST',{userIds:[c.id]})).status).toBe(200);
 const history=await api(`/api/v1/chats/${group.conversationId}/messages`,c);
 expect((await history.json()).messages.map(m=>m.text)).toEqual(['Вчерашние новости']);
 expect((await api(`/api/v1/chats/${group.conversationId}/receipts/read`,c,'POST',{messageIds:[message.messageId]})).status).toBe(200);
 const presence=await api('/api/v1/presence',a);
 expect((await presence.json()).users.map(user=>user.userId).sort()).toEqual([b.id,c.id].sort());
});

test('group voice upload is shared with members but inaccessible to outsiders',async()=>{
 const [a,b,c]=await Promise.all(['alpha','beta','gamma'].map(register));
 const created=await api('/api/v1/chats/groups',a,'POST',{title:'Звуки',historyMode:'all',userIds:[b.id]});
 expect(created.status).toBe(201);
 const group=(await created.json()).chat;
 const path=`/api/v1/chats/${group.conversationId}`;
 const input={mimeType:'audio/webm;codecs=opus',bitrateBps:64000};
 expect((await api(`${path}/voice/uploads`,c,'POST',input)).status).toBe(404);
 const start=await api(`${path}/voice/uploads`,a,'POST',input);
 expect(start.status).toBe(201);
 const upload=(await start.json()).upload;
 const env=await server.getWorker('bulbam-api-test').getEnv();
 const response=await env.VOICE_UPLOAD.getByName(upload.sessionId).fetch('https://voice-upload.internal/socket',{
   headers:{Upgrade:'websocket','x-bulbam-user-id':a.id,'x-bulbam-conversation-id':group.conversationId,'x-bulbam-voice-session-id':upload.sessionId}
 });
 expect(response.status).toBe(101);
 const socket=response.webSocket;
 function next(type){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`No ${type}`)),5000);const onMessage=e=>{
   try{const event=JSON.parse(e.data);if(event.type===type){clearTimeout(timeout);socket.removeEventListener('message',onMessage);resolve(event);}}catch{}};
   socket.addEventListener('message',onMessage);});}
 const ready=next('voice.upload.ready');socket.accept();await ready;
 const bytes=new Uint8Array(512).fill(77);const frame=new Uint8Array(516);
 new DataView(frame.buffer).setUint32(0,1,false);frame.set(bytes,4);
 const ack=next('voice.upload.ack');socket.send(frame.buffer);expect((await ack).partNumber).toBe(1);socket.close(1000,'complete');
 const finished=await api(`${path}/voice/uploads/${upload.sessionId}/complete`,a,'POST',{
   clientMessageId:'group_voice_0003',chunkCount:1,sizeBytes:512,durationMs:2000
 });
 expect(finished.status).toBe(201);
 const message=(await finished.json()).message;
 expect(message.kind).toBe('voice');
 expect((await (await api(`${path}/messages`,b)).json()).messages[0].voice.sizeBytes).toBe(512);
 const audio=await api(`${path}/messages/${message.messageId}/voice/audio`,b,'GET',undefined,{range:'bytes=0-31'});
 expect(audio.status).toBe(206);expect((await audio.arrayBuffer()).byteLength).toBe(32);
 expect((await api(`${path}/messages/${message.messageId}/voice/audio`,c)).status).toBe(404);
});

test('protected private chats enforce ciphertext across both devices and reject ordinary voice uploads',async()=>{
 const [a,b,c]=await Promise.all(['alpha','beta','gamma'].map(register));
 const open=await api('/api/v1/chats/direct',a,'POST',{userId:b.id});
 expect(open.status).toBe(200);
 const chat=(await open.json()).chat;
 expect(chat.encryptionMode).toBe('plain');
 const path=`/api/v1/chats/${chat.conversationId}`;
 const old=await api(`${path}/messages`,a,'POST',{clientMessageId:'old_text_0001',text:'Открытый текст'});
 expect(old.status).toBe(201);
 expect((await api(`${path}/protection`,c,'POST',{})).status).toBe(404);
 const enabled=await api(`${path}/protection`,a,'POST',{});
 expect(enabled.status).toBe(200);
 expect((await enabled.json()).encryptionMode).toBe('protected');
 expect((await (await api('/api/v1/chats',b)).json()).chats[0].encryptionMode).toBe('protected');
 expect((await api(`${path}/messages`,a,'POST',{clientMessageId:'unsafe_0002',text:'нельзя'})).status).toBe(409);
 expect((await api(`${path}/messages`,b,'POST',{clientMessageId:'unsafe_0003',text:'нельзя'})).status).toBe(409);
 expect((await api(`${path}/voice/uploads`,a,'POST',{mimeType:'audio/webm;codecs=opus',bitrateBps:64000})).status).toBe(409);
 const encrypted='bmsec1:1234567890123456.'+'A'.repeat(50);
 expect((await api(`${path}/messages`,a,'POST',{clientMessageId:'encrypted_0004',text:encrypted})).status).toBe(201);
 expect((await (await api(`${path}/messages`,b)).json()).messages.at(-1).text).toBe(encrypted);
 expect((await api(`${path}/voice/uploads`,a,'POST',{mimeType:'application/vnd.bulbam.encrypted-voice;v=1;codec=mp4;nonce=1234567890123456',bitrateBps:64000})).status).toBe(201);
 expect((await (await api(`${path}/messages`,b)).json()).messages[0].text).toBe('Открытый текст');
});
