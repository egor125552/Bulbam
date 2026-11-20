import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,afterEach,beforeAll,describe,expect,test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {normalizeUsername,registrationInput} from '../worker/src/modules/identity/domain/validation.ts';

const server=createTestHarness({workers:[{configPath:'./wrangler.test.jsonc'}]});
const invite='CYRILLIC-USERNAMES-OWNER-INVITATION-2026';
beforeAll(()=>server.listen());
afterEach(()=>server.reset());
afterAll(()=>server.close());

async function post(path,body={},cookie){
 return server.fetch(path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
}
async function seeded(){
 await server.fetch('/api/ready');
 const env=await server.getWorker('bulbam-api-test').getEnv();
 await env.DB.prepare('INSERT INTO invites (invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)')
  .bind('cyrillic-owner-invite',createHash('sha256').update(invite).digest('hex'),'owner',Date.now()).run();
 return env;
}
async function owner(username='ЁГОР_125',displayName){
 await seeded();
 const body={username,password:'good-secret-pass-2026',inviteCode:invite,deviceName:'Test',...(displayName===undefined?{}:{displayName})};
 const response=await post('/api/v1/auth/register',body);
 const json=await response.json();
 const cookie='bulbam_session='+response.headers.get('set-cookie')?.match(/bulbam_session=([^;]+)/)?.[1];
 return {response,json,cookie};
}

describe('Cyrillic usernames and optional display names',()=>{
 test('registration UI prompts for the optional profile only after the backup-code step',()=>{
  const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const register=html.match(/<form id="register-form"[\s\S]*?<\/form>/)?.[0]??'';
  expect(register).toContain('name="username"');
  expect(register).not.toContain('name="displayName"');
  expect(html).toContain('id="profile-first-setup-dialog"');
  expect(html).toContain('id="profile-first-setup-skip"');
  expect(html).toContain('id="profile-settings-form"');
  expect(html).toContain('id="profile-settings-display-name"');
  const auth=readFileSync(new URL('../web/js/auth.js',import.meta.url),'utf8');
  expect(auth).toContain('scheduleOptionalNameSetup(result.recoveryCodes)');
  expect(auth).toContain('dialog.addEventListener("close",()=>queueMicrotask(showOptionalNameSetup)');
 });

 test('normalization accepts Russian and Belarusian letters, keeps existing Latin rules and rejects unsafe text',()=>{
  expect(normalizeUsername(' @ЁГОР_125 ')).toBe('ёгор_125');
  expect(normalizeUsername('ЎЛАД123')).toBe('ўлад123');
  expect(normalizeUsername('ＥＧＯＲ１２３')).toBe('egor123');
  expect(normalizeUsername('EGOR125')).toBe('egor125');
  for(const text of ['a','👁️👁️👁️','name with space','я-123','а\u200dб123'])
   expect(()=>normalizeUsername(text)).toThrow();
 });
 test('registration succeeds without displayName and uses canonical username as default',async()=>{
  const {response,json,cookie}=await owner();
  expect(response.status).toBe(201);
  expect(json.account.username).toBe('ёгор_125');
  expect(json.account.displayName).toBe('ёгор_125');
  const login=await post('/api/v1/auth/login',{username:'ЁГОР_125',password:'good-secret-pass-2026'});
  expect(login.status).toBe(200);
  expect((await login.json()).account.username).toBe('ёгор_125');
  const privateProfile=await server.fetch('/api/v1/auth/me',{headers:{cookie}});
  expect((await privateProfile.json()).account.displayName).toBe('ёгор_125');
 });
 test('existing clients may still set displayName while joining, and script variants cannot duplicate same username',async()=>{
  const {response,json}=await owner('ЕГОР123','Егор');
  expect(response.status).toBe(201);
  expect(json.account.displayName).toBe('Егор');
  const env=await server.getWorker('bulbam-api-test').getEnv();
  const secondInvite='ANOTHER-INVITE-FOR-CYRILLIC-2026';
  await env.DB.prepare('INSERT INTO invites (invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)')
    .bind('cyrillic-second-invite',createHash('sha256').update(secondInvite).digest('hex'),'member',Date.now()).run();
  const duplicate=await post('/api/v1/auth/register',{username:'егор123',password:'second-long-pass-2026',inviteCode:secondInvite});
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error.code).toBe('username_taken');
 });
 test('signed-in user may set display name later but no unauthenticated client can edit it',async()=>{
  const {cookie}=await owner('ВЛАД_2026');
  const url='/api/v1/auth/profile';
  const anonymous=await server.fetch(url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:'Захват'})});
  expect(anonymous.status).toBe(401);
  const changed=await server.fetch(url,{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({displayName:'Мой ник'})});
  expect(changed.status).toBe(200);
  expect((await changed.json()).account.displayName).toBe('Мой ник');
  const me=await server.fetch('/api/v1/auth/me',{headers:{cookie}});
  expect((await me.json()).account.displayName).toBe('Мой ник');
  const invalid=await server.fetch(url,{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({displayName:'   '})});
  expect(invalid.status).toBe(400);
 });
 test('searching Cyrillic usernames works using uppercase query',async()=>{
  const {cookie}=await owner('МИЛА_2026');
  const env=await server.getWorker('bulbam-api-test').getEnv();
  const another='CYRILLIC-BELARUSIAN-FRIEND-2026';
  await env.DB.prepare('INSERT INTO invites (invite_id,code_hash,role_grant,created_at) VALUES (?,?,?,?)')
    .bind('cyrillic-search-friend',createHash('sha256').update(another).digest('hex'),'member',Date.now()).run();
  const response=await post('/api/v1/auth/register',{username:'ўлад_2026',password:'another-pass-2026',inviteCode:another});
  expect(response.status).toBe(201);
  const found=await server.fetch('/api/v1/users/search?q='+encodeURIComponent('ЎЛАД'),{headers:{cookie}});
  expect(found.status).toBe(200);
  expect((await found.json()).users.some(user=>user.username==='ўлад_2026')).toBe(true);
 });
});
