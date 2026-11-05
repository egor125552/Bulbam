import { translateText } from "./i18n.js";
// A quiet original WAV loop may help expose headset media keys, but cannot
// prevent iOS from suspending WebRTC/audio in the background or locked state.
export function createCallKeepaliveAudio(audio,navigatorLike){
 let active=false,epoch=0,pending=null;
 async function resume(){
  if(!active)return;
  if(pending)return pending;
  if(!audio.paused)return;
  const token=epoch;
  const playing=Promise.resolve().then(()=>audio.play());
  pending=playing;
  try {await playing;}catch{}
  finally {
   if(pending===playing)pending=null;
   if(!active || token!==epoch)audio.pause();
  }
 }
 return {
  activate(peer){
   active=true;audio.loop=true;audio.volume=0.01;
   try{if(typeof MediaMetadata!=="undefined" && navigatorLike?.mediaSession)
     navigatorLike.mediaSession.metadata=new MediaMetadata({title:translateText("Звонок Бульбама"),artist:peer||"Бульбам",album:translateText("Аудиозвонок")});}catch{}
   void resume();
  },
  resume,
  deactivate(){active=false;epoch++;audio.pause();try{audio.currentTime=0;}catch{}
   try{if(navigatorLike?.mediaSession)navigatorLike.mediaSession.metadata=null;}catch{}},
  get active(){return active;}
 };
}
