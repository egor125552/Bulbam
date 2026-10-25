// Keep the original audio element untouched for ordinary, unencrypted voice.
// A stereo file whose microphone recorded only the left or right channel
// should be heard in both headphones when played through protected transport.
export function prepareVoiceOutput(audio,protectedMime,ContextClass=globalThis.AudioContext??globalThis.webkitAudioContext??null){
 if(!protectedMime||!ContextClass)return null;
 let context=null,source=null;
 try{
  context=new ContextClass();
  source=context.createMediaElementSource(audio);
  const centered=context.createGain();
  // Web Audio's speakers interpretation downmixes stereo to a mono voice,
  // then upmixes that mono channel equally to left and right at destination.
  centered.channelInterpretation='speakers';
  centered.channelCountMode='explicit';
  centered.channelCount=1;
  source.connect(centered);
  centered.connect(context.destination);
  return {
   resume:()=>context.resume(),
   close:()=>context.close()
  };
 }catch(error){
  // Once an element has a MediaElementSource, it cannot go back to direct
  // playback: restore an audible path instead of silently muting it.
  if(source&&context){
   try{
    source.connect(context.destination);
    return {resume:()=>context.resume(),close:()=>context.close()};
   }catch{}
  }
  try{void context?.close();}catch{}
  return null;
 }
}
