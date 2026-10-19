import { describe, test, expect } from 'vitest';
import { createTestHarness } from 'wrangler';
import { translateServerText } from '../worker/src/i18n.ts';
import { be } from '../web/js/locales/be.js';
const server = createTestHarness({ workers:[{configPath:'./wrangler.test.jsonc'}] });
describe('registration invalid username guidance',()=>{
 test('invalid punctuation in username returns localized guidance without restricting display name',async()=>{
  await server.listen();
  try {
   const body={username:'Ягор-123',displayName:'Ягор',password:'long-enough-password',inviteCode:'mock-invitation-not-used'};
   const response=await server.fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json','accept-language':'be'},body:JSON.stringify(body)});
   expect(response.status).toBe(400);
   const parsed=await response.json();
   expect(parsed.error.code).toBe('invalid_username');
   expect(parsed.error.message).toMatch(/беларускіх/);
   expect(parsed.error.message).toMatch(/карыстальнік1/);
   expect(parsed.error.message).not.toMatch(/Username|латинских/);
  }finally{await server.close();}
 });
 test('client can translate username guidance and keep a Latin example',()=>{
  const guidance='Имя пользователя: от 3 до 32 русских, белорусских или латинских букв, цифр и знаков подчёркивания. Например, пользователь1.';
  expect(be[guidance]).toMatch(/беларускіх/);
  expect(be[guidance]).toContain('карыстальнік1');
  expect(translateServerText(guidance)).toBe(be[guidance]);
 });
});
