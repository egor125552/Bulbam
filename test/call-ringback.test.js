import {afterEach,describe,expect,test,vi} from 'vitest';
import {prepareRingback,startRingback,stopRingback} from '../web/js/call-ringback.js';
afterEach(()=>{stopRingback();vi.useRealTimers();delete globalThis.window;});
describe('local outgoing ringback',()=>{
 test('rings until answered, never keeps the timer after stopping',async()=>{
  vi.useFakeTimers();
  let started=0,stopped=0;
  class AudioContextFake {
    state="running";currentTime=0;destination={};
    createOscillator(){return {frequency:{value:0},connect(){return this;},start(){started++;},stop(){stopped++;}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){return this;}};}
  }
  globalThis.window={AudioContext:AudioContextFake};
  prepareRingback();
  startRingback();
  startRingback();
  expect(started).toBe(1);
  await vi.advanceTimersByTimeAsync(3700);
  expect(started).toBe(2);
  stopRingback();
  await vi.advanceTimersByTimeAsync(8000);
  expect(started).toBe(2);
  expect(stopped).toBeGreaterThanOrEqual(2);
 });
});
