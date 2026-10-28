// Experimental, optional call effects. Pure parameter normalization is deliberately
// independent from WebRTC. No profile may silently enable audio processing.
export const VOICE_LAB_DEFAULTS = Object.freeze({
  enabled:false, preset:"clean", target:"remote", tremoloHz:5, reverb:2, reverbTail:5,
  radioNoise:0.18, interference:0.15, noiseFrequency:1800,
  x:0, y:0, distance:1, autoBleep:false
});
export const VOICE_PRESETS=Object.freeze(["clean","tremolo","reverb","radio","interference"]);
const numbers={tremoloHz:[0.4,18],reverb:[0,4],reverbTail:[0.6,12],radioNoise:[0,0.65],
  interference:[0,0.7],noiseFrequency:[250,5200],x:[-4,4],y:[-4,4],distance:[0.5,16]};
export function normalizeVoiceLabState(input={}) {
  const next={...VOICE_LAB_DEFAULTS};
  next.enabled=input.enabled===true;
  next.preset=VOICE_PRESETS.includes(input.preset)?input.preset:"clean";
  next.target=input.target==="outgoing"?"outgoing":"remote";
  for(const [key,[min,max]] of Object.entries(numbers)){
    const v=Number(input[key]);
    if(Number.isFinite(v))next[key]=Math.min(max,Math.max(min,v));
  }
  return next;
}
export function radioNoiseBuffer(ctx,duration=2) {
  const rate=ctx.sampleRate||48000,count=Math.ceil(rate*duration);
  const buffer=ctx.createBuffer(1,count,rate);
  let seed=0x9e3779b9;
  const out=buffer.getChannelData(0);
  // Uniform white noise, no repeated short artificial oscillator pattern.
  let burst=0;
  for(let i=0;i<count;i++){
    seed ^= seed <<13; seed ^= seed>>>17; seed ^= seed<<5;
    const random=(seed>>>0)/2147483648-1;
    // Background broadband hiss plus unpredictable small crackles, rather
    // than a periodic square-wave pretending to be radio interference.
    if((seed&65535)<12)burst=1;
    burst*=0.994;
    out[i]=random*(0.22+1.15*burst);
  }
  return buffer;
}
