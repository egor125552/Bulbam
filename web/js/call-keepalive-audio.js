import { translateText } from "./i18n.js";
// A quiet original WAV loop may help expose headset media keys, but cannot
// prevent iOS from suspending WebRTC/audio in the background or locked state.
export function createCallKeepaliveAudio(audio,navigatorLike){
 let active=false,epoch=0,pending=null;
 async function resume(){
  if(!active || !audio || typeof audio.play!=="function")return;
  if(pending)return pending;
  if(!audio.paused)return;
  const token=epoch;
  const playing=Promise.resolve().then(()=>audio.play());
  pending=playing;
  try {await playing;}catch{}
  finally {
   if(pending===playing)pending=null;
   if(!active || token!==epoch)audio.pause?.();
  }
 }
 return {
  activate(peer){
   // A stale cached app shell or a simplified WebView may lack this element.
   // Optional headset audio must never prevent an actual call from starting.
   if(!audio || typeof audio.play!=="function" || typeof audio.pause!=="function")return false;
   active=true;audio.loop=true;audio.volume=0.01;
   try{if(typeof MediaMetadata!=="undefined" && navigatorLike?.mediaSession)
     navigatorLike.mediaSession.metadata=new MediaMetadata({title:translateText("Звонок Бульбама"),artist:peer||"Бульбам",album:translateText("Аудиозвонок")});}catch{}
   void resume();
   return true;
  },
  resume,
  deactivate(){active=false;epoch++;try{audio?.pause?.();}catch{}
   try{if(audio)audio.currentTime=0;}catch{}
   try{if(navigatorLike?.mediaSession)navigatorLike.mediaSession.metadata=null;}catch{}},
  get active(){return active;}
 };
}
