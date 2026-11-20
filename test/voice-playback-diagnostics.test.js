import {describe,expect,test} from 'vitest';
import {explainVoicePlaybackError} from '../web/js/voice-playback-diagnostics.js';
describe('specific voice playback failure guidance',()=>{
  test('distinguishes network, media corruption, and unsupported formats',()=>{
    expect(explainVoicePlaybackError(2)).toMatch(/сети/);
    expect(explainVoicePlaybackError(3)).toMatch(/декодировать/);
    expect(explainVoicePlaybackError(4)).toMatch(/Формат/);
    expect(explainVoicePlaybackError(null)).toMatch(/Не удалось/);
  });
});
