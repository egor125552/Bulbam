import {describe,expect,test} from "vitest";
import {parseHTML} from "linkedom";
import {readFileSync} from "node:fs";
import {
  VOICE_LAB_DEFAULTS,VOICE_PRESETS,hasProfanity,
  normalizeVoiceLabState,radioNoiseBuffer,canUseLocalRussianRecognition
} from "../web/js/call-voice-lab-core.js";

describe("separate opt-in voice laboratory",()=>{
  test("starts disabled and does not silently restore auto-censorship",()=>{
    expect(VOICE_LAB_DEFAULTS.enabled).toBe(false);
    expect(normalizeVoiceLabState({enabled:true,autoBleep:true}).autoBleep).toBe(false);
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
  test("recognizes whole Russian profanity stems without matching ordinary words",()=>{
    expect(hasProfanity("ну пиздец что происходит")).toBe(true);
    expect(hasProfanity("ПИЗДА")).toBe(true);
    expect(hasProfanity("нахуй")).toBe(true);
    expect(hasProfanity("хорошо, друзья")).toBe(false);
    expect(hasProfanity("это сучок дерева")).toBe(false);
  });
  test("refuses non-local or missing ASR even if browser offers cloud speech",async()=>{
    class LocalSpeech { processLocally=false; }
    LocalSpeech.available=async()=> "available";
    expect(await canUseLocalRussianRecognition({SpeechRecognition:LocalSpeech})).toBe(true);
    class FakeCloudSpeech {}
    FakeCloudSpeech.available=async()=> "available";
    expect(await canUseLocalRussianRecognition({SpeechRecognition:FakeCloudSpeech})).toBe(false);
    expect(await canUseLocalRussianRecognition({webkitSpeechRecognition:class {}})).toBe(false);
    class OfflineSpeech { processLocally=false; }
    OfflineSpeech.available=async()=> "downloadable";
    expect(await canUseLocalRussianRecognition({SpeechRecognition:OfflineSpeech})).toBe(false);
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
    for(const id of ["tremoloHz","reverb","radioNoise","interference","noiseFrequency","x","y","distance"]){
      expect(document.querySelector('label[for="voice-lab-'+id+'"]')).toBeTruthy();
      expect(document.getElementById("voice-lab-"+id)?.getAttribute("type")).toBe("range");
    }
    expect(document.querySelector("#voice-lab-auto").disabled).toBe(true);
    expect(document.querySelector("#voice-lab-target option[value=outgoing]")).toBeTruthy();
  });
});
