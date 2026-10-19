import {describe,expect,test} from 'vitest';
import {explainMicrophoneError} from '../web/js/microphone-permissions.js';
describe('mic error guidance without pretending to control OS permissions',()=>{
 test('explains denial and busy microphone instead of raw browser exception',()=>{
  expect(explainMicrophoneError({name:'NotAllowedError'})).toMatch(/настройках/);
  expect(explainMicrophoneError({name:'NotReadableError'})).toMatch(/другой звонок/);
  expect(explainMicrophoneError({name:'NotFoundError'})).toMatch(/Микрофон не найден/);
  expect(explainMicrophoneError({name:'OverconstrainedError'})).toMatch(/качество/);
 });
});
