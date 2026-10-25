import {createHash,webcrypto} from 'node:crypto';
import {test,expect,beforeAll,afterAll,afterEach} from 'vitest';
import {createTestHarness} from 'wrangler';
const server=createTestHarness({workers:[{configPath:'./wrangler.test.jsonc'}]});
const crypto=webcrypto;
const b64=bytes=>Buffer.from(bytes).toString('base64url');
const publicPart=key=>({kty:'EC',crv:'P-256',x:key.x,y:key.y});
const sign=(key,text)=>crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(text)).then(b64);
async function generate(userId){
  const deviceId=crypto.randomUUID();
  const signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const agreement=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const prekey=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const bundle={deviceId,
    identitySigning:publicPart(await crypto.subtle.exportKey('jwk',signing.publicKey)),
    identityAgreement:publicPart(await crypto.subtle.exportKey('jwk',agreement.publicKey)),
    signedPrekey:publicPart(await crypto.subtle.exportKey('jwk',prekey.publicKey))};
  bundle.prekeySignature=await sign(signing.privateKey,JSON.stringify(['bulbam/device-prekey/v1',userId,deviceId,bundle.signedPrekey]));
  bundle.registrationSignature=await sign(signing.privateKey,JSON.stringify(['bulbam/device-registration/v1',userId,deviceId,bundle.identitySigning,bundle.identityAgreement,bundle.signedPrekey,bundle.prekeySignature]));
  return {bundle,privateKey:signing.privateKey};
}
async function register(name){
  await server.fetch('/api/ready');
  const env=await server.getWorker('bulbam-api-test').getEnv();
  const inviteCode='DEVICE-'+name+'-INVITE-2026';
  await env.DB.prepare('INSERT INTO invites(invite_id,code_hash,created_by_user_id,role_grant,created_at,expires_at,used_at,used_by_user_id) VALUES(?,?,NULL,\'member\',?,NULL,NULL,NULL)')
    .bind('device-invite-'+name,createHash('sha256').update(inviteCode).digest('hex'),Date.now()).run();
  const reply=await server.fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'dev_'+name,displayName:name,password:'StrongPassword2026!Device',inviteCode,deviceName:'Test'})});
  expect(reply.status).toBe(201);
  return {id:(await reply.json()).account.userId,cookie:'bulbam_session='+reply.headers.get('set-cookie').match(/bulbam_session=([^;]+)/)[1]};
}
const api=(route,actor,method='GET',body)=>server.fetch(route,{method,headers:{cookie:actor?.cookie??'',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
beforeAll(async()=>server.listen());
afterEach(async()=>server.reset());
afterAll(async()=>server.close());
test('signatures are required, first device is active, additional devices pending until signed approval',async()=>{
 const user=await register('first');
 const first=await generate(user.id),second=await generate(user.id);
 let reply=await api('/api/v1/e2ee/devices',user,'POST',{...first.bundle,registrationSignature:'A'.repeat(86)});
 expect(reply.status).toBe(400);
 reply=await api('/api/v1/e2ee/devices',user,'POST',first.bundle);
 expect(reply.status).toBe(201);
 expect((await reply.json()).device.trust).toBe('active');
 expect((await api('/api/v1/e2ee/devices',user,'POST',first.bundle)).status).toBe(201);
 reply=await api('/api/v1/e2ee/devices',user,'POST',second.bundle);
 expect(reply.status).toBe(201);
 expect((await reply.json()).device.trust).toBe('pending');
 expect((await api('/api/v1/e2ee/devices',user)).status).toBe(200);
 expect((await (await api('/api/v1/e2ee/devices',user)).json()).devices.map(x=>x.trust)).toEqual(['active','pending']);
 expect((await api('/api/v1/e2ee/devices/approve',user,'POST',{newDeviceId:second.bundle.deviceId,approverDeviceId:first.bundle.deviceId,signature:'A'.repeat(86)})).status).toBe(400);
 const signature=await sign(first.privateKey,JSON.stringify(['bulbam/device-approval/v1',user.id,first.bundle.deviceId,second.bundle.deviceId,second.bundle.identitySigning,second.bundle.identityAgreement,second.bundle.signedPrekey]));
 expect((await api('/api/v1/e2ee/devices/approve',user,'POST',{newDeviceId:second.bundle.deviceId,approverDeviceId:first.bundle.deviceId,signature})).status).toBe(200);
 expect((await api('/api/v1/e2ee/devices/approve',user,'POST',{newDeviceId:second.bundle.deviceId,approverDeviceId:first.bundle.deviceId,signature})).status).toBe(409);
 expect((await (await api('/api/v1/e2ee/devices',user)).json()).devices.map(x=>x.trust)).toEqual(['active','active']);
});
test('device directory requires chat membership and returns only approved devices',async()=>{
 const a=await register('alice'),b=await register('bob'),outsider=await register('eve');
 const first=await generate(a.id),pending=await generate(a.id);
 await api('/api/v1/e2ee/devices',a,'POST',first.bundle);
 await api('/api/v1/e2ee/devices',a,'POST',pending.bundle);
 const chat=(await (await api('/api/v1/chats/direct',a,'POST',{userId:b.id})).json()).chat;
 const path=`/api/v1/chats/${chat.conversationId}/e2ee/devices`;
 expect((await api(path,outsider)).status).toBe(404);
 const view=await api(path,b);expect(view.status).toBe(200);
 expect((await view.json()).users.find(x=>x.userId===a.id).devices.map(x=>x.deviceId)).toEqual([first.bundle.deviceId]);
 expect((await api('/api/v1/e2ee/devices',null)).status).toBe(401);
});
test('only another trusted device may revoke; private signatures cannot be replayed for a changed key',async()=>{
 const user=await register('revoke');
 const a=await generate(user.id),b=await generate(user.id);
 await api('/api/v1/e2ee/devices',user,'POST',a.bundle);await api('/api/v1/e2ee/devices',user,'POST',b.bundle);
 const signature=await sign(a.privateKey,JSON.stringify(['bulbam/device-approval/v1',user.id,a.bundle.deviceId,b.bundle.deviceId,b.bundle.identitySigning,b.bundle.identityAgreement,b.bundle.signedPrekey]));
 await api('/api/v1/e2ee/devices/approve',user,'POST',{newDeviceId:b.bundle.deviceId,approverDeviceId:a.bundle.deviceId,signature});
 expect((await api('/api/v1/e2ee/devices/revoke',user,'POST',{deviceId:b.bundle.deviceId,approverDeviceId:a.bundle.deviceId,signature})).status).toBe(400);
 const revokeSignature=await sign(a.privateKey,JSON.stringify(['bulbam/device-revoke/v1',user.id,a.bundle.deviceId,b.bundle.deviceId]));
 expect((await api('/api/v1/e2ee/devices/revoke',user,'POST',{deviceId:b.bundle.deviceId,approverDeviceId:a.bundle.deviceId,signature:revokeSignature})).status).toBe(200);
 expect((await api('/api/v1/e2ee/devices',user,'POST',b.bundle)).status).toBe(409);
 expect((await api('/api/v1/e2ee/devices/revoke',user,'POST',{deviceId:a.bundle.deviceId,approverDeviceId:b.bundle.deviceId,signature:revokeSignature})).status).toBe(409);
});
