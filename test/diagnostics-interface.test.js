import {readFileSync} from "node:fs";
import {describe,expect,test} from "vitest";
const html=readFileSync(new URL("../web/index.html",import.meta.url),"utf8");
const calls=readFileSync(new URL("../web/js/calls.js",import.meta.url),"utf8");
const voice=readFileSync(new URL("../web/js/voice-recorder.js",import.meta.url),"utf8");
const api=readFileSync(new URL("../web/js/api.js",import.meta.url),"utf8");
describe("diagnostics available independently of the active call",()=>{
  test("full journal is in settings instead of the call panel, accessible for VoiceOver",()=>{
    const callPanel=html.slice(html.indexOf('<section id="call-panel"'),html.indexOf('<audio id="call-remote-audio"'));
    expect(callPanel).not.toContain('id="call-event-log"');
    expect(callPanel).not.toContain('id="call-diagnostics"');
    const settings=html.slice(html.indexOf('class="diagnostics-panel"'));
    expect(settings).toContain('id="diagnostics-log" readonly');
    expect(settings).toContain('id="diagnostics-download"');
    expect(settings).toContain('id="diagnostics-copy"');
    expect(settings).toContain('id="diagnostics-clear"');
    expect(settings).toContain('id="call-diagnostics-text"');
  });
  test("call, API and recording modules write to same safe journal",()=>{
    expect(calls).toContain('logCallEvent(');
    expect(calls).not.toContain('#call-event-log');
    expect(api).toContain('describeApiOperation');
    expect(voice).toContain('logDiagnostic("Голосовые"');
    expect(voice).toContain('keepVoiceRaw');
  });
});
