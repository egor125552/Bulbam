import {describe,test,expect} from 'vitest';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const {document}=parseHTML(html);
describe('minimal screen reader interface for chat protection',()=>{
 test('chat header exposes only the Protection action, no encryption status or description',()=>{
   const header=document.querySelector('.conversation-header');
   expect(header.querySelector('#secure-chat-open')?.textContent).toBe('Защита');
   expect(header.querySelector('#secure-chat-label')).toBeNull();
   expect(header.textContent).not.toMatch(/Защищённый чат|Без сквозного шифрования/);
 });
 test('protect dialog has one primary enable/disable choice, advanced recovery hidden by default',()=>{
   const dialog=document.querySelector('#secure-chat-dialog');
   expect(dialog.querySelector('#secure-chat-toggle-on')?.textContent).toBe('Включить защиту');
   expect(dialog.querySelector('#secure-chat-toggle-off')?.textContent).toBe('Выключить защиту');
   expect(dialog.querySelector('#secure-chat-toggle-on').hasAttribute('hidden')).toBe(true);
   expect(dialog.querySelector('#secure-chat-toggle-off').hasAttribute('hidden')).toBe(true);
   expect(dialog.querySelector('#secure-chat-legacy-tools')?.hasAttribute('hidden')).toBe(true);
   expect(dialog.querySelector('#secure-chat-status')?.hasAttribute('hidden')).toBe(true);
   expect(dialog.querySelector('#secure-chat-status')?.getAttribute('aria-live')).toBeNull();
 });
});
