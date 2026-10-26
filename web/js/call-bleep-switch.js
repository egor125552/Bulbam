// A manual switch, not speech recognition. It gates the complete outgoing
// voice and substitutes a continuous 1 kHz tone until the switch is disabled.
export function createContinuousBleep(ctx,sourceStream,destination) {
  const source=ctx.createMediaStreamSource(sourceStream);
  const voiceGain=ctx.createGain();
  const tone=ctx.createOscillator();
  const toneGain=ctx.createGain();
  source.connect(voiceGain);
  voiceGain.connect(destination);
  tone.type="sine";
  tone.frequency.value=1000;
  tone.connect(toneGain);
  toneGain.connect(destination);
  toneGain.gain.value=0;
  voiceGain.gain.value=1;
  tone.start();
  let enabled=false,closed=false;
  function setEnabled(next){
    if(closed)return;
    enabled=Boolean(next);
    const t=ctx.currentTime;
    for(const param of [voiceGain.gain,toneGain.gain]){
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value,t);
    }
    // 4ms crossfade eliminates switching clicks. No timers or ASR latency.
    voiceGain.gain.linearRampToValueAtTime(enabled?0:1,t+.004);
    toneGain.gain.linearRampToValueAtTime(enabled?.2:0,t+.004);
  }
  function close(){
    if(closed)return;
    closed=true;
    try{tone.stop();}catch{}
    for(const n of [source,voiceGain,tone,toneGain])try{n.disconnect();}catch{}
  }
  return {setEnabled,close,get enabled(){return enabled;}};
}
