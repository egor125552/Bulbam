import { describe, expect, test } from 'vitest';
import { createRecordingClock } from '../web/js/voice-recording-clock.js';
describe('voice recording pause/resume timeline',()=>{
 test('excludes time spent paused, including a stop while paused',()=>{
  const clock=createRecordingClock(1000);
  expect(clock.elapsed(4000)).toBe(3000);
  expect(clock.pause(4000)).toBe(true);
  expect(clock.elapsed(12000)).toBe(3000);
  expect(clock.pause(12000)).toBe(false);
  expect(clock.resume(12000)).toBe(true);
  expect(clock.elapsed(14500)).toBe(5500);
  expect(clock.resume(14500)).toBe(false);
  clock.pause(15000);
  expect(clock.elapsed(25000)).toBe(6000);
 });
 test('monotonic positive elapsed and no double-count for repeated pause',()=>{
  const clock=createRecordingClock(1000);
  clock.pause(2000);
  clock.pause(8000);
  expect(clock.elapsed(9000)).toBe(1000);
  clock.resume(9000);
  expect(clock.elapsed(10000)).toBe(2000);
 });
});
