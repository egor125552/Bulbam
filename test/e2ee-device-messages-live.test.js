import {createHash,webcrypto} from 'node:crypto';
import {beforeAll,afterAll,afterEach,test,expect} from 'vitest';
import 'fake-indexeddb/auto';
import {createTestHarness} from 'wrangler';
import {registerCurrentDevice} from '../web/js/device-identity.js';
import {sendDeviceText,receiveDeviceText,createDeviceEnvelope} from '../web/js/e2ee-device-envelopes.js';
import {readEncryptedHistory} from '../web/js/e2ee-history.js';
const server=createTestHarness({workers:[{configPath:'./wrangler.test.jsonc'}]});
const originalCrypto=globalThis.crypto;
beforeAll(async()=>{Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});await server.listen();});
afterEach(async()=>server.reset());
afterAll(async()=>{await server.close();if(originalCrypto)Object.defineProperty(globalThis,'crypto',{value:originalCrypto,configurable:true});});
async function register(name){
 await server.fetch('/api/ready');
 const env=await server.getWorker('bulbam-api-test').getEnv();
 const code='STAGE-E2EE-'+name+'-2026';
 await env.DB.prepare("INSERT INTO invites(invite_id,code_hash,created_by_user_id,role_grant,created_at,expires_at,used_at,used_by_user_id) VALUES(?,?,NULL,'member',?,NULL,NULL,NULL)")
 .bind('stage_e2ee_'+name,createHash('sha256').update(code).digest('hex'),Date.now()).run();
 const response=await server.fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
  username:'stage_e2ee_'+name,displayName:name,password:'StrongPass99ForStage!',inviteCode:code,deviceName:'Stage'
 })});
 expect(response.status).toBe(201);
 return {id:(await response.json()).account.userId,cookie:'bulbam_session='+response.headers.get('set-cookie').match(/bulbam_session=([^;]+)/)[1]};
}
function request(user){
 return async(path,options={})=>{
  const res=await server.fetch(path,{method:options.method??'GET',
   headers:{cookie:user.cookie,'content-type':'application/json'},body:options.body});
  const body=await res.json();
  if(!res.ok)throw Object.assign(Error('HTTP '+res.status+': '+JSON.stringify(body)),{status:res.status,body});
  return body;
 };
}
test('actual Worker + D1: Alice encrypts, Bob decrypts, server sees only ciphertext and ACK removes copy',async()=>{
 const a=await register('alice'),b=await register('bob'),c=await register('outsider');
 const alice=request(a),bob=request(b),outsider=request(c);
 const da=await registerCurrentDevice(a.id,alice),db=await registerCurrentDevice(b.id,bob);
 expect(da.trust).toBe('active');expect(db.trust).toBe('active');
 const chat=(await alice('/api/v1/chats/direct',{method:'POST',body:JSON.stringify({userId:b.id})})).chat;
 const path='/api/v1/chats/'+chat.conversationId+'/e2ee/envelopes';
 const secret='Бульбам: настоящий шифротекст через D1. 1234567890';
 const sent=await sendDeviceText({accountId:a.id,conversationId:chat.conversationId,recipientUserId:b.id,text:secret,request:alice});
 expect(sent.recipientDeviceCount).toBe(1);
 const raw=await bob(path+'?deviceId='+db.deviceId);
 await expect(bob(path+'/'+(await bob(path+'?deviceId='+db.deviceId)).envelopes[0].envelopeId+'/ack',{method:'POST',body:JSON.stringify({deviceId:db.deviceId,signature:'A'.repeat(86)})})).rejects.toMatchObject({status:400});
 expect(raw.envelopes).toHaveLength(1);
 expect(raw.envelopes[0].ciphertext).not.toContain(secret);
 expect(JSON.stringify(raw.envelopes[0])).not.toContain(secret);
 expect(raw.envelopes[0].senderUserId).toBe(a.id);
 expect(raw.envelopes[0].senderSigningKey).toEqual(da.identitySigning);
 const dbEnv=await server.getWorker('bulbam-api-test').getEnv();
 const stored=await dbEnv.DB.prepare('SELECT ciphertext,signature FROM e2ee_device_envelopes WHERE recipient_user_id=?')
  .bind(b.id).first();
 expect(stored.ciphertext).toBe(raw.envelopes[0].ciphertext);
 expect(JSON.stringify(stored)).not.toContain(secret);
 const decrypted=await receiveDeviceText({accountId:b.id,conversationId:chat.conversationId,request:bob});
 expect(decrypted).toMatchObject([{senderUserId:a.id,clientMessageId:sent.clientMessageId,text:secret}]);
 expect((await readEncryptedHistory(b.id,chat.conversationId))[0].text).toBe(secret);
 expect((await receiveDeviceText({accountId:b.id,conversationId:chat.conversationId,request:bob}))[0].text).toBe(secret);
 expect((await receiveDeviceText({accountId:a.id,conversationId:chat.conversationId,request:alice}))[0].text).toBe(secret);
 expect((await bob(path+'?deviceId='+db.deviceId)).envelopes).toHaveLength(0);
 const deletedDirectory=async(route,options)=>{
  const result=await bob(route,options);
  if(route.endsWith('/e2ee/devices'))return {...result,
    users:result.users.map(entry=>entry.userId===a.id?{...entry,devices:[]}:entry)};
  return result;
 };
 expect((await receiveDeviceText({accountId:b.id,conversationId:chat.conversationId,request:deletedDirectory}))[0].text).toBe(secret);
 await expect(outsider(path+'?deviceId='+db.deviceId)).rejects.toMatchObject({status:404});
 await expect(alice(path+'?deviceId='+db.deviceId)).rejects.toMatchObject({status:403});
},30000);
test('actual Worker rejects unsigned forgery, tampered ciphertext and untrusted recipient',async()=>{
 const a=await register('sender'),b=await register('receiver');
 const alice=request(a),bob=request(b);
 const da=await registerCurrentDevice(a.id,alice),db=await registerCurrentDevice(b.id,bob);
 const chat=(await alice('/api/v1/chats/direct',{method:'POST',body:JSON.stringify({userId:b.id})})).chat;
 const path='/api/v1/chats/'+chat.conversationId+'/e2ee/envelopes';
 const packet=await createDeviceEnvelope({accountId:a.id,conversationId:chat.conversationId,recipientUserId:b.id,
  recipientDevice:db,plaintext:'Защищённая строка'});
 const forged={...packet,ciphertext:packet.ciphertext.replace(/^./,packet.ciphertext[0]==='A'?'B':'A')};
 await expect(alice(path,{method:'POST',body:JSON.stringify(forged)})).rejects.toMatchObject({status:400});
 const created=await alice(path,{method:'POST',body:JSON.stringify(packet)});
 expect(created.envelope.recipientUserId).toBe(b.id);
 const exactRepeat=await alice(path,{method:'POST',body:JSON.stringify(packet)});
 expect(exactRepeat.envelope.envelopeId).toBe(created.envelope.envelopeId);
 await expect(alice(path,{method:'POST',body:JSON.stringify({...packet,recipientDeviceId:webcrypto.randomUUID()})})).rejects.toMatchObject({status:409});
 const received=await receiveDeviceText({accountId:b.id,conversationId:chat.conversationId,request:bob});
 expect(received[0].text).toBe('Защищённая строка');
},30000);
test('voice v2: real Durable Object stores encrypted sound, Worker delivers per-device key, Bob decrypts original audio',async()=>{
 const {prepareDeviceVoice,publishDeviceVoice,importDeviceVoiceKey}=await import('../web/js/e2ee-device-voice.js');
 const {encryptedVoiceMime,generateVoiceNonce,encryptVoicePart,decryptVoiceFile}=await import('../web/js/secure-voice.js');
 const a=await register('voicealice'),b=await register('voicebob'),c=await register('voiceoutsider');
 const alice=request(a),bob=request(b),outsider=request(c);
 await registerCurrentDevice(a.id,alice);await registerCurrentDevice(b.id,bob);
 const chat=(await alice('/api/v1/chats/direct',{method:'POST',body:JSON.stringify({userId:b.id})})).chat;
 const conversationId=chat.conversationId;
 const voice=await prepareDeviceVoice({accountId:a.id,conversationId,recipientUserId:b.id,request:alice});
 expect(voice.key.extractable).toBe(false);
 const mime=encryptedVoiceMime('audio/webm;codecs=opus',generateVoiceNonce());
 const clientMessageId=webcrypto.randomUUID();
 const plain=webcrypto.getRandomValues(new Uint8Array(64000));
 const context={conversationId,senderUserId:a.id,clientMessageId};
 const encrypted=await encryptVoicePart(plain,voice.key,mime,context,1,plain.byteLength);
 expect(encrypted.byteLength).toBe(plain.length+16);
 expect(encrypted.slice(0,32)).not.toEqual(plain.slice(0,32));
 const started=await alice('/api/v1/chats/'+conversationId+'/voice/uploads',{
  method:'POST',body:JSON.stringify({mimeType:mime,bitrateBps:64000})
 });
 const sessionId=started.upload.sessionId;
 const env=await server.getWorker('bulbam-api-test').getEnv();
 const upgraded=await env.VOICE_UPLOAD.getByName(sessionId).fetch('https://voice-upload.internal/socket',{
  headers:{Upgrade:'websocket','x-bulbam-user-id':a.id,'x-bulbam-conversation-id':conversationId,'x-bulbam-voice-session-id':sessionId}
 });
 expect(upgraded.status).toBe(101);
 const socket=upgraded.webSocket;
 expect(socket).toBeTruthy();
 const waitEvent=kind=>new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{socket.removeEventListener('message',onMessage);reject(Error('Timed out '+kind));},5000);
  function onMessage(event){if(typeof event.data!=='string')return;let value;try{value=JSON.parse(event.data);}catch{return;}
   if(value.type!==kind)return;clearTimeout(timeout);socket.removeEventListener('message',onMessage);resolve(value);}
  socket.addEventListener('message',onMessage);
 });
 const ready=waitEvent('voice.upload.ready');socket.accept();await ready;
 const ack=waitEvent('voice.upload.ack');
 const frame=new Uint8Array(4+encrypted.byteLength);new DataView(frame.buffer).setUint32(0,1);frame.set(encrypted,4);
 socket.send(frame.buffer);expect((await ack).partNumber).toBe(1);socket.close(1000,'test complete');
 const complete=await alice('/api/v1/chats/'+conversationId+'/voice/uploads/'+sessionId+'/complete',{
  method:'POST',body:JSON.stringify({clientMessageId,durationMs:3000,chunkCount:1,sizeBytes:encrypted.byteLength})
 });
 expect(complete.message.voice.mimeType).toBe(mime);
 const remotePath='/api/v1/chats/'+conversationId+'/messages/'+sessionId+'/voice/audio';
 const res=await server.fetch(remotePath,{headers:{cookie:b.cookie}});
 expect(res.status).toBe(200);
 const cipher=await res.arrayBuffer();
 expect(new Uint8Array(cipher)).toEqual(encrypted);
 expect(Array.from(new Uint8Array(cipher.slice(0,24)))).not.toEqual(Array.from(plain.slice(0,24)));
 // An audio upload alone does not disclose the voice key; it is independently published through E2EE.
 const delivered=await publishDeviceVoice({accountId:a.id,conversationId,recipientUserId:b.id,
   voiceMessage:complete.message,rawKey:voice.rawKey,request:alice});
 expect(delivered.recipientDeviceCount).toBe(1);
 const decrypted=await receiveDeviceText({accountId:b.id,conversationId,request:bob});
 const msg=decrypted.find(item=>item.kind==='voice'&&item.messageId===sessionId);
 expect(msg).toBeTruthy();
 expect(msg.voiceKey.extractable).toBe(false);
 const decoded=await decryptVoiceFile(new Blob([cipher]),msg.voiceKey,mime,context);
 expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(plain);
 const changed=new Uint8Array(cipher);changed[changed.length-1]^=1;
 await expect(decryptVoiceFile(new Blob([changed]),msg.voiceKey,mime,context)).rejects.toThrow();
 const other=await importDeviceVoiceKey(voice.rawKey);
 expect(other.extractable).toBe(false);
 const foreign=await server.fetch(remotePath,{headers:{cookie:c.cookie}});
 expect(foreign.status).toBe(404);
},40000);

test('partial device delivery is resumable: identical ciphertext reused after network failure',async()=>{
 const a=await register('retrya'),b=await register('retryb');
 const alice=request(a),bob=request(b);
 await registerCurrentDevice(a.id,alice);await registerCurrentDevice(b.id,bob);
 const conversationId=(await alice('/api/v1/chats/direct',{
  method:'POST',body:JSON.stringify({userId:b.id})
 })).chat.conversationId;
 const clientMessageId=webcrypto.randomUUID();
 let posts=0;
 const unreliable=async(path,options)=>{
  if(path.endsWith('/e2ee/envelopes')&&options?.method==='POST'&&++posts===2)
   throw Error('simulated network failure');
  return alice(path,options);
 };
 await expect(sendDeviceText({accountId:a.id,conversationId,recipientUserId:b.id,text:'Запись голосового защищена',
   clientMessageId,request:unreliable})).rejects.toThrow('simulated');
 await expect(sendDeviceText({accountId:a.id,conversationId,recipientUserId:b.id,text:'ДРУГОЕ',
   clientMessageId,request:alice})).rejects.toThrow('другим содержимым');
 const resumed=await sendDeviceText({accountId:a.id,conversationId,recipientUserId:b.id,
  text:'Запись голосового защищена',clientMessageId,request:alice});
 expect(resumed.recipientDeviceCount).toBe(1);
 const received=await receiveDeviceText({accountId:b.id,conversationId,request:bob});
 expect(received.find(x=>x.clientMessageId===clientMessageId).text).toBe('Запись голосового защищена');
 const copies=await receiveDeviceText({accountId:a.id,conversationId,request:alice});
 expect(copies.find(x=>x.clientMessageId===clientMessageId).text).toBe('Запись голосового защищена');
},30000);

test('after a page failure the stored ciphertext can be delivered without retaining plaintext',async()=>{
 const {resumeDeviceOutbox}=await import('../web/js/e2ee-device-envelopes.js');
 const {listEncryptedOutbox}=await import('../web/js/e2ee-outbox.js');
 const a=await register('resumea'),b=await register('resumeb');
 const alice=request(a),bob=request(b);
 await registerCurrentDevice(a.id,alice);await registerCurrentDevice(b.id,bob);
 const conversationId=(await alice('/api/v1/chats/direct',{
  method:'POST',body:JSON.stringify({userId:b.id})
 })).chat.conversationId;
 let posts=0;
 const interrupted=async(path,options)=>{
  if(path.endsWith('/e2ee/envelopes')&&options?.method==='POST'&&++posts===2)
   throw Error('page closed halfway');
  return alice(path,options);
 };
 await expect(sendDeviceText({accountId:a.id,conversationId,recipientUserId:b.id,
  text:'После закрытия вкладки остаётся только шифротекст',request:interrupted
 })).rejects.toThrow('page closed');
 expect((await listEncryptedOutbox(a.id,conversationId))).toHaveLength(1);
 // No draft text is needed to resume, because every recipient packet was stored encrypted.
 await resumeDeviceOutbox({accountId:a.id,conversationId,request:alice});
 expect((await listEncryptedOutbox(a.id,conversationId))).toHaveLength(0);
 const received=await receiveDeviceText({accountId:b.id,conversationId,request:bob});
 expect(received[0].text).toBe('После закрытия вкладки остаётся только шифротекст');
},30000);
