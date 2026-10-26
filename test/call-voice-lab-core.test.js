import {describe,expect,test} from "vitest";
import {parseHTML} from "linkedom";
import {readFileSync} from "node:fs";
import {
  VOICE_LAB_DEFAULTS,VOICE_PRESETS,
  normalizeVoiceLabState,radioNoiseBuffer
} from "../web/js/call-voice-lab-core.js";

describe("separate opt-in voice laboratory",()=>{
  test("starts disabled and reverb has a strong 5-second tail",()=>{
    expect(VOICE_LAB_DEFAULTS.enabled).toBe(false);
    expect(VOICE_LAB_DEFAULTS.reverb).toBe(2);
    expect(VOICE_LAB_DEFAULTS.reverbTail).toBe(5);
    expect(normalizeVoiceLabState({target:"unknown",preset:"unknown"})).toMatchObject({target:"remote",preset:"clean",enabled:false});
  });
  test("limits spatial position, distance and noise to safe numeric ranges",()=>{
    const x=normalizeVoiceLabState({x:-500,y:500,distance:500,radioNoise:8,noiseFrequency:NaN,tremoloHz:-20});
    expect(x).toMatchObject({x:-4,y:4,distance:16,radioNoise:0.65,noiseFrequency:1800,tremoloHz:0.4});
    expect(VOICE_PRESETS).toContain("radio");
    expect(VOICE_PRESETS).toContain("interference");
  });
  test("uses actual broadband noise instead of an oscillator for radio hiss",()=>{
    let a;
    const ctx={sampleRate:8000,createBuffer:(_,n)=>({getChannelData:()=>a=new Float32Array(n)})};
    const b=radioNoiseBuffer(ctx,1);
    expect(b).toBeDefined();
    expect(a.length).toBe(8000);
    expect(a.some(x=>x>0)).toBe(true);
    expect(a.some(x=>x<0)).toBe(true);
    expect(new Set(a.slice(0,500)).size).toBeGreaterThan(450);
  });
  test("reverb settings allow extended 12-second reflection tails",()=>{
    const intense=normalizeVoiceLabState({reverb:100,reverbTail:300});
    expect(intense.reverb).toBe(4);
    expect(intense.reverbTail).toBe(12);
  });
});

const html=readFileSync(new URL("../web/index.html",import.meta.url),"utf8");
const {document}=parseHTML(html);
describe("call effects screen remains accessible and separate from messaging",()=>{
  test("preserves the normal call button and text composer; effects are opt-in",()=>{
    expect(document.getElementById("message-input")).not.toBeNull();
    expect(document.querySelector("#voice-lab-open")?.hidden).toBe(true);
    expect(document.querySelector("#voice-lab-enabled")?.checked).toBeFalsy();
    const dialog=document.getElementById("voice-lab-dialog");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("voice-lab-title");
    expect(dialog?.querySelector("#voice-lab-status").getAttribute("role")).toBe("status");
    expect(dialog?.contains(document.getElementById("call-remote-audio"))).toBe(false);
  });
  test("every slider has a distinct label and no effect changes call controls",()=>{
    for(const id of ["tremoloHz","reverb","radioNoise","interference","noiseFrequency","reverbTail","x","y","distance"]){
      expect(document.querySelector('label[for="voice-lab-'+id+'"]')).toBeTruthy();
      expect(document.getElementById("voice-lab-"+id)?.getAttribute("type")).toBe("range");
    }
    expect(document.querySelector("#voice-lab-auto")).toBeNull();
    expect(document.querySelector("#voice-lab-target option[value=outgoing]")).toBeTruthy();
    expect(document.querySelector("#voice-lab-bleep-enabled")?.getAttribute("type")).toBe("checkbox");
    expect(document.querySelector("#call-bleep-toggle")?.getAttribute("aria-pressed")).toBe("false");
    expect(html).not.toContain("SpeechRecognition");
  });
});
