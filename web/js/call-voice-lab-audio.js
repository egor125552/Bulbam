import {radioNoiseBuffer,normalizeVoiceLabState} from "./call-voice-lab-core.js";

// Each chain owns only its own nodes. No AudioContext is created while the lab
// is disabled, so normal mic capture and normal call playback stay untouched.
export function makeVoiceLabChain(ctx, stream, settings, destination) {
  const state=normalizeVoiceLabState(settings);
  const nodes=[];
  const node=(value)=>{nodes.push(value);return value;};
  const source=node(ctx.createMediaStreamSource(stream));
  const high=node(ctx.createBiquadFilter());high.type="highpass";
  const low=node(ctx.createBiquadFilter());low.type="lowpass";
  const distort=node(ctx.createWaveShaper());
  const gate=node(ctx.createGain());
  source.connect(high);high.connect(low);low.connect(distort);distort.connect(gate);
  const dry=node(ctx.createGain()),wet=node(ctx.createGain());
  const verb=node(ctx.createConvolver());
  let impulseTail=state.reverbTail;
  verb.buffer=createImpulse(ctx,impulseTail);
  const speechGate=node(ctx.createGain());speechGate.gain.value=1;
  gate.connect(speechGate);speechGate.connect(dry);speechGate.connect(verb);verb.connect(wet);
  const spatial=node(ctx.createPanner());
  spatial.panningModel="HRTF";spatial.distanceModel="inverse";
  spatial.refDistance=1;spatial.maxDistance=24;spatial.rolloffFactor=1;
  dry.connect(spatial);wet.connect(spatial);
  // White noise travels through a radio bandpass. Short broadband crackle
  // already exists in the noise buffer. It never relies on a single tone.
  const hiss=node(ctx.createBufferSource());hiss.buffer=radioNoiseBuffer(ctx);hiss.loop=true;
  const band=node(ctx.createBiquadFilter());band.type="bandpass";band.Q.value=0.65;
  const noiseGain=node(ctx.createGain());hiss.connect(band);band.connect(noiseGain);noiseGain.connect(spatial);
  spatial.connect(destination);
  const tremoloOsc=node(ctx.createOscillator()),tremoloDepth=node(ctx.createGain());
  const tremoloBase=node(ctx.createConstantSource());
  tremoloOsc.type="sine";tremoloOsc.connect(tremoloDepth);tremoloDepth.connect(gate.gain);
  tremoloBase.connect(gate.gain);gate.gain.value=0;
  tremoloOsc.start();tremoloBase.start();hiss.start();
  const strength=node(ctx.createGain()); // optional beep is routed directly to output
  const beepOsc=node(ctx.createOscillator());beepOsc.type="sine";beepOsc.frequency.value=1000;
  beepOsc.connect(strength);strength.gain.value=0;strength.connect(destination);beepOsc.start();
  let stopped=false;
  function update(input) {
    if(stopped)return;
    const s=normalizeVoiceLabState(input);
    const radio=s.preset==="radio", interference=s.preset==="interference";
    high.frequency.value=radio?420:interference?230:65;
    low.frequency.value=radio?2500:interference?4600:20000;
    distort.curve=radio?makeSaturation(300):null;
    // Dry output is deliberately lowered at high reverb settings so the
    // tail becomes audible instead of disappearing beneath the direct voice.
    dry.gain.value=s.preset==="reverb"?Math.max(0.38,0.92-s.reverb*0.13):1;
    wet.gain.value=s.preset==="reverb"?Math.min(2.5,s.reverb*0.66):0;
    if(s.reverbTail!==impulseTail){
      impulseTail=s.reverbTail;
      verb.buffer=createImpulse(ctx,impulseTail);
    }
    band.frequency.value=s.noiseFrequency;
    noiseGain.gain.value=radio?s.radioNoise:interference?s.interference:0;
    tremoloOsc.frequency.value=s.tremoloHz;
    tremoloDepth.gain.value=s.preset==="tremolo"?0.48:0;
    tremoloBase.offset.value=s.preset==="tremolo"?0.52:1;
    spatial.positionX.value=s.x;
    spatial.positionY.value=s.y;
    spatial.positionZ.value=-s.distance;
  }
  function bleep(ms=350){
    if(stopped)return false;
    const t=ctx.currentTime+0.004,seconds=Math.max(0.1,Math.min(.8,ms/1000));
    speechGate.gain.cancelScheduledValues(t);
    speechGate.gain.setValueAtTime(speechGate.gain.value,t);
    speechGate.gain.linearRampToValueAtTime(0,t+.006);
    speechGate.gain.setValueAtTime(0,t+seconds-.014);
    speechGate.gain.linearRampToValueAtTime(1,t+seconds);
    strength.gain.setValueAtTime(0,t);
    strength.gain.linearRampToValueAtTime(.18,t+.008);
    strength.gain.setValueAtTime(.18,t+seconds-.014);
    strength.gain.linearRampToValueAtTime(0,t+seconds);
    return true;
  }
  function close() {
    if(stopped)return;
    stopped=true;
    for(const n of [hiss,tremoloOsc,tremoloBase,beepOsc])try{n.stop();}catch{}
    for(const n of nodes)try{n.disconnect();}catch{}
  }
  update(state);
  return {update,bleep,close,source,spatial};
}
function makeSaturation(amount){
  const curve=new Float32Array(1024);
  for(let i=0;i<curve.length;i++){
    const x=i*2/(curve.length-1)-1;
    curve[i]=Math.tanh(amount*x/90)/Math.tanh(amount/90);
  }
  return curve;
}
export function createImpulse(ctx,seconds=5){
  // Long stereo diffuse impulse with a recognizable tail. Unlike the old
  // 0.85-second impulse, this reaches up to 12 seconds for cathedral-style
  // reflections, but allocates only when the tail duration changes.
  seconds=Math.max(.6,Math.min(12,Number(seconds)||5));
  const length=Math.max(256,Math.floor(ctx.sampleRate*seconds));
  const buffer=ctx.createBuffer(2,length,ctx.sampleRate);
  let seed=832945;
  for(let channel=0;channel<2;channel++){
    const data=buffer.getChannelData(channel);
    for(let i=0;i<length;i++){
      seed=(seed*1664525+1013904223)>>>0;
      const noise=(seed/2147483648)-1;
      const t=i/ctx.sampleRate;
      const tail=Math.exp(-4.3*t/seconds);
      const predelay=i<Math.floor(ctx.sampleRate*.025)?0.16:1;
      const early=(t>.055&&t<.075)||(t>.11&&t<.135)?1.35:1;
      data[i]=noise*tail*predelay*early*0.24;
    }
  }
  return buffer;
}
