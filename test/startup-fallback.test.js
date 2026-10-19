import {readFileSync} from 'node:fs';
import {describe,expect,test} from 'vitest';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
describe('fail-safe startup UI for iOS and other browsers',()=>{
 test('has a VoiceOver-readable error and retry action outside signed-in/out states',()=>{
  expect(html).toContain('id="startup-failure"');
  expect(html).toContain('role="alert" aria-live="assertive"');
  expect(html).toContain('id="startup-retry"');
  expect(html.indexOf('id="startup-failure"')).toBeLessThan(html.indexOf('id="signed-out"'));
 });
 test('catches module startup errors and times out instead of staying loading forever',()=>{
  expect(html).toContain('window.bulbamBootFailed(error)');
  expect(html).toContain('window.bulbamBootReady()');
  expect(html).toContain('startup_timeout');
  expect(html).toContain('import("/app.js?v=20261019-startup-fix-1")');
 });
 test('does not clear browser sessions as a recovery action',()=>{
  expect(html).not.toContain('localStorage.clear()');
  expect(html).not.toContain('indexedDB.deleteDatabase');
 });
});
