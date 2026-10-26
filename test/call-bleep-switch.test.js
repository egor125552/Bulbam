import {describe,expect,test} from "vitest";
import {createContinuousBleep} from "../web/js/call-bleep-switch.js";
import {createImpulse} from "../web/js/call-voice-lab-audio.js";

const param=(value=0)=>({value,history:[],cancelScheduledValues(t){this.history.push(["cancel",t]);},setValueAtTime(v,t){this.value=v;this.history.push(["set",v,t]);},linearRampToValueAtTime(v,t){this.value=v;this.history.push(["ramp",v,t]);}});
function fakeContext(){
 const gains=[];
 const node=()=>({connect(){},disconnect(){}});
 const oscillator={...node(),frequency:param(1000),start(){this.started=true;},stop(){this.stopped=true;}};
 return {ctx:{currentTime:20,sampleRate:1000,createMediaStreamSource:node,createOscillator:()=>oscillator,createGain:()=>{let n={...node(),gain:param()};gains.push(n);return n;}},gains,oscillator};
}
describe("manual continuous beep",()=>{
 test("switch gates speech and substitutes tone without timers or recognition",()=>{
  const {ctx,gains,oscillator}=fakeContext();
  const chain=createContinuousBleep(ctx,{},{});
  expect(chain.enabled).toBe(false);
  expect(oscillator.started).toBe(true);
  chain.setEnabled(true);
  expect(chain.enabled).toBe(true);
  expect(gains[0].gain.value).toBe(0);
  expect(gains[1].gain.value).toBe(.2);
  expect(gains[0].gain.history.at(-1)).toEqual(["ramp",0,20.004]);
  chain.setEnabled(false);
  expect(chain.enabled).toBe(false);
  expect(gains[0].gain.value).toBe(1);
  expect(gains[1].gain.value).toBe(0);
  chain.close();chain.close();
  expect(oscillator.stopped).toBe(true);
 });
 test("reverb uses requested twelve-second stereo impulse",()=>{
  const lengths=[];
  const ctx={sampleRate:1000,createBuffer:(c,len)=>{lengths.push(len);let data=Array.from({length:c},()=>new Float32Array(len));return {data,getChannelData:i=>data[i]};}};
  const result=createImpulse(ctx,12);
  expect(lengths).toEqual([12000]);
  expect(result.data.length).toBe(2);
  expect(result.data[0].slice(40,400).some(x=>x!==0)).toBe(true);
  expect(result.data[0].slice(-100).some(x=>x!==0)).toBe(true);
  createImpulse(ctx,500);expect(lengths.at(-1)).toBe(12000);
 });
});
