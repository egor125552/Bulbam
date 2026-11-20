import {describe,test,expect,afterEach,vi} from 'vitest';
import {logDiagnostic,diagnosticText,clearDiagnostics,logApiStart,logApiResult,logTraceEvent,diagnosticStats} from '../web/js/diagnostics-log.js';
import {switchCallAudioProfile} from '../web/js/call-audio-switch.js';
import {applyCallConstraintsBestEffort} from '../web/js/call-constraint-fallback.js';
afterEach(clearDiagnostics);
describe('full app technical diary without personal content',()=>{
 test('records more than nine hundred events, orders each event, and exposes total',()=>{
  for(let i=0;i<1005;i++)logDiagnostic('Сеть','соединение работает');
  const lines=diagnosticText().split('\n');
  expect(lines).toHaveLength(1005);
  expect(lines.at(-1)).toMatch(/№1005/);
  expect(diagnosticStats().count).toBe(1005);
 });
 test('records all successful polling replies rather than hiding nine out of ten',()=>{
  for(let i=0;i<5;i++){logApiStart('GET сигналы звонка');logApiResult('GET сигналы звонка',200,175);}
  expect(diagnosticText().split('\n').filter(line=>line.includes('фоновый опрос'))).toHaveLength(5);
 });
 test('logs safe trace stages and numeric metrics; rejects raw secrets',()=>{
  logTraceEvent('Звонки','создание WebRTC','начало',{attempt:2,durationMs:19,secret:'password private',url:'https://secret'});
  const data=diagnosticText();
  expect(data).toContain('создание WebRTC');
  expect(data).toContain('attempt 2');
  expect(data).toContain('durationMs 19');
  expect(data).not.toContain('password');
  expect(data).not.toContain('https://');
 });
 test('traces alternative microphone capture even if it throws',async()=>{
  const stages=[];
  const stream={getAudioTracks:()=>[{kind:'audio'}]};
  await switchCallAudioProfile({oldStream:stream,sender:{replaceTrack(){}},isCurrent:()=>true,
   acquire:vi.fn().mockRejectedValue(Object.assign(new Error('private-device'),{name:'NotReadableError'})),
   applyExisting:vi.fn().mockRejectedValue(Object.assign(new Error('private'),{name:'OverconstrainedError'})),
   trace:(name,detail)=>stages.push([name,detail])});
  expect(stages.map(([stage])=>stage)).toEqual(expect.arrayContaining(['новый захват начало','новый захват ошибка','запасной способ начало','запасной способ ошибка']));
  expect(JSON.stringify(stages)).not.toContain('private-device');
 });
 test('traces each individual rejected browser audio constraint safely',async()=>{
  const stages=[];
  const track={applyConstraints:vi.fn().mockRejectedValue(Object.assign(new Error('private'),{name:'OverconstrainedError'}))};
  await expect(applyCallConstraintsBestEffort(track,{echoCancellation:false,noiseSuppression:false,autoGainControl:false},(stage,detail)=>stages.push([stage,detail]))).rejects.toThrow();
  expect(stages.map(([stage])=>stage)).toContain('echoCancellation ошибка');
  expect(stages.map(([stage])=>stage)).toContain('noiseSuppression ошибка');
  expect(JSON.stringify(stages)).not.toContain('private');
 });
});
