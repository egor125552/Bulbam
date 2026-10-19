import {afterEach,describe,expect,test,vi} from 'vitest';
import {prepareRingback,startRingback,stopRingback} from '../web/js/call-ringback.js';
afterEach(()=>{stopRingback();vi.useRealTimers();delete globalThis.window;});
describe('local outgoing ringback',()=>{
 test('waits for Safari audio resume, then rings until answered',async()=>{
  vi.useFakeTimers();
  let started=0,stopped=0,resumed=0;
  class AudioContextFake {
    state='suspended';currentTime=0;destination={};
    async resume(){resumed++;this.state='running';}
    createOscillator(){return {frequency:{value:0},connect(){return this;},start(){started++;},stop(){stopped++;}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){return this;}};}
  }
  globalThis.window={AudioContext:AudioContextFake};
  await prepareRingback();
  startRingback();
  startRingback();
  await vi.runAllTicks();
  expect(resumed).toBe(1);
  expect(started).toBe(2);
  await vi.advanceTimersByTimeAsync(2900);
  expect(started).toBe(4);
  stopRingback();
  await vi.advanceTimersByTimeAsync(8000);
  expect(started).toBe(4);
  expect(stopped).toBeGreaterThanOrEqual(4);
 });
});
