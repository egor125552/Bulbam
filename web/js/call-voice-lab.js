import {VOICE_LAB_DEFAULTS,normalizeVoiceLabState} from "./call-voice-lab-core.js";
import {makeVoiceLabChain} from "./call-voice-lab-audio.js";
import {createContinuousBleep} from "./call-bleep-switch.js";

const KEY="bulbam.experimental.voiceLab.v2";
const fields=["tremoloHz","reverb","reverbTail","radioNoise","interference","noiseFrequency","x","y","distance"];
const ui=name=>typeof document==="undefined"?null:document.getElementById?.("voice-lab-"+name)??null;
const quickBleep=()=>typeof document==="undefined"?null:document.getElementById?.("call-bleep-toggle")??null;

let getCallMedia=()=>null;
let state=readSettings();
let context=null,chain=null,chainTarget=null,processedDestination=null;
let sourceStream=null,sender=null,sourceTrack=null,activeCallId=null;
let remoteAudio=null;
let operation=Promise.resolve();

// This is a MANUAL continuously active censorship switch. It does not parse
// speech, inspect messages, or trigger recognition, and resets after each call.
let bleepOn=false,bleepChain=null,bleepSender=null,bleepOriginal=null;
let bleepDestination=null,bleepCallId=null;

function readSettings(){
  try{
    const current=localStorage.getItem(KEY);
    if(current)return normalizeVoiceLabState(JSON.parse(current));
    const legacy=localStorage.getItem("bulbam.experimental.voiceLab.v1");
    if(legacy){
      const old=JSON.parse(legacy);
      return normalizeVoiceLabState({...old,reverb:Math.max(2,(Number(old.reverb)||.35)*4),reverbTail:5});
    }
  }catch{}
  return normalizeVoiceLabState();
}
function save(){
  const {enabled,...persisted}=state;
  try{localStorage.setItem(KEY,JSON.stringify(persisted));}catch{}
}
function status(text){if(ui("status"))ui("status").textContent=text;}
function helpMessage(){return "Настройки принадлежат этому устройству. Эффект своего голоса услышит собеседник, эффект его голоса услышите только вы.";}
function updateBleepControls(){
  if(ui("bleep-enabled"))ui("bleep-enabled").checked=bleepOn;
  const button=quickBleep();
  if(button){
    button.textContent=bleepOn?"Запикивание включено":"Запикивание выключено";
    button.setAttribute("aria-pressed",String(bleepOn));
    button.setAttribute("aria-label",bleepOn
      ?"Выключить запикивание. Сейчас собеседник слышит сигнал."
      :"Включить запикивание моего голоса.");
  }
}
function toggleBleep(next){
  bleepOn=Boolean(next);
  updateBleepControls();
  // Stop the tone immediately, even if an older replaceTrack() operation
  // is still in flight. The Web Audio crossfade takes only 4ms.
  if(!bleepOn)bleepChain?.setEnabled(false);
  if(bleepOn){
    // The resume() attempt must start inside the click gesture on iPhone.
    void openContext().then(()=>enqueue()).catch(error=>{
      bleepOn=false;updateBleepControls();
      status("Не удалось включить запикивание: "+error.message);
    });
  }else{
    void enqueue();
    status("Запикивание выключено. Собеседник снова слышит ваш голос.");
  }
}
export function setupCallVoiceLab(mediaGetter){
  getCallMedia=mediaGetter;
  const dialog=ui("dialog"),open=ui("open"),close=ui("close");
  if(!dialog||!open)return;
  open.addEventListener("click",()=>{
    render();
    dialog.showModal();
    ui("enabled")?.focus();
    status(helpMessage());
  });
  close?.addEventListener("click",()=>dialog.close());
  dialog.addEventListener("close",()=>open.focus({preventScroll:true}));
  ui("enabled")?.addEventListener("change",()=>{
    state.enabled=ui("enabled").checked;
    if(!state.enabled){void enqueue();return;}
    void openContext().then(()=>enqueue()).catch(error=>{
      state.enabled=false;ui("enabled").checked=false;
      status("Не удалось включить звуковые эффекты: "+error.message);
    });
  });
  for(const name of ["preset","target",...fields]){
    ui(name)?.addEventListener("change",()=>{
      state=normalizeVoiceLabState({...state,[name]:ui(name).value,enabled:state.enabled});
      save();refreshVisibility();void enqueue();
    });
    if(fields.includes(name))ui(name)?.addEventListener("input",()=>{
      state=normalizeVoiceLabState({...state,[name]:ui(name).value,enabled:state.enabled});
      save();
      // Tail regeneration is expensive. Apply it on release, not per pixel.
      if(chain && name!=="reverbTail")chain.update(state);
      const value=ui(name+"-value");if(value)value.textContent=String(state[name]);
      if(name==="tremoloHz"&&ui("tremolo-period"))
        ui("tremolo-period").textContent=`Период тремоло: ${Math.round(1000/state.tremoloHz)} мс`;
    });
  }
  ui("reset")?.addEventListener("click",()=>{
    state={...VOICE_LAB_DEFAULTS};
    save();render();void enqueue();
  });
  ui("bleep-enabled")?.addEventListener("change",()=>toggleBleep(ui("bleep-enabled").checked));
  quickBleep()?.addEventListener("click",()=>toggleBleep(!bleepOn));
  updateBleepControls();
  render();
}
function render(){
  if(!ui("preset"))return;
  ui("preset").value=state.preset;
  ui("target").value=state.target;
  ui("enabled").checked=state.enabled;
  for(const name of fields){
    ui(name).value=String(state[name]);
    const label=ui(name+"-value");if(label)label.textContent=String(state[name]);
  }
  if(ui("tremolo-period"))
    ui("tremolo-period").textContent=`Период тремоло: ${Math.round(1000/state.tremoloHz)} мс`;
  refreshVisibility();
  updateBleepControls();
}
function refreshVisibility(){
  for(const [name,presets] of [["tremolo-options",["tremolo"]],
    ["reverb-options",["reverb"]],["radio-options",["radio","interference"]]]){
    const root=ui(name);if(root)root.hidden=!presets.includes(state.preset);
  }
}
function enqueue(){
  operation=operation.catch(()=>{}).then(async()=>{
    // Bleep is the FINAL outgoing WebRTC stage, independent from effects on
    // either microphone or incoming voice. Rewire in a strict order.
    await detachBleep();
    await applyCurrentSettings();
    if(bleepOn)await attachBleep();
  }).catch(async error=>{
    bleepOn=false;updateBleepControls();
    state.enabled=false;
    if(ui("enabled"))ui("enabled").checked=false;
    status("Эффекты не применились, обычный звук сохранён: "+error.message);
    try{await detachBleep();await stopProcessing();}catch{}
  });
  return operation;
}
async function openContext(){
  if(!context||context.state==="closed"){
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)throw Error("Web Audio не поддерживается.");
    context=new Audio();
  }
  if(context.state!=="running"){
    await context.resume();
    if(context.state!=="running")throw Error("Нужно разрешить воспроизведение звука в Safari.");
  }
  return context;
}
async function applyCurrentSettings(){
  const media=getCallMedia?.();
  if(!state.enabled){
    await stopProcessing();
    status("Эффекты выключены. Обычный звук звонка восстановлен.");
    return;
  }
  if(!media?.callId||!media.pc){
    await stopProcessing();
    status("Эффекты будут доступны после подключения звука звонка.");
    return;
  }
  const stream=state.target==="outgoing"?media.localStream:media.remoteAudio?.srcObject;
  if(!stream?.getAudioTracks?.().length){
    await stopProcessing();
    status("Ожидаю аудиодорожку. Можно продолжать звонок без эффектов.");
    return;
  }
  if(chain && chainTarget===state.target && activeCallId===media.callId && sourceStream===stream){
    chain.update(state);return;
  }
  await stopProcessing();
  const ctx=await openContext();
  if(state.target==="remote"){
    const next=makeVoiceLabChain(ctx,stream,state,ctx.destination);
    remoteAudio=media.remoteAudio;
    chain=next;chainTarget="remote";sourceStream=stream;activeCallId=media.callId;
    remoteAudio.muted=true;
    status("Слушаете собеседника с эффектом.");
  }else{
    const currentSender=media.pc.getSenders().find(item=>item.track?.kind==="audio");
    const raw=stream.getAudioTracks()[0];
    if(!currentSender||!raw)throw Error("Микрофон ещё не готов.");
    const destination=ctx.createMediaStreamDestination();
    let next;
    try{
      next=makeVoiceLabChain(ctx,stream,state,destination);
      const transformed=destination.stream.getAudioTracks()[0];
      transformed.enabled=raw.enabled;
      await currentSender.replaceTrack(transformed);
    }catch(error){
      next?.close();
      destination.stream.getTracks().forEach(track=>track.stop());
      throw error;
    }
    processedDestination=destination;
    sender=currentSender;sourceTrack=raw;
    chain=next;chainTarget="outgoing";sourceStream=stream;activeCallId=media.callId;
    status("Ваш голос обрабатывается перед отправкой собеседнику.");
  }
}
async function stopProcessing(){
  const prior=chain,oldSender=sender,original=sourceTrack,target=chainTarget;
  if(target==="remote"&&remoteAudio)remoteAudio.muted=false;
  if(target==="outgoing"&&oldSender&&original?.readyState!=="ended"){
    const transformed=processedDestination?.stream.getAudioTracks()[0];
    // Do not overwrite a newer profile or another call's replacement track.
    if(!transformed || oldSender.track===transformed)
      try{await oldSender.replaceTrack(original);}catch{}
  }
  prior?.close();
  processedDestination?.stream.getTracks().forEach(track=>track.stop());
  chain=null;chainTarget=null;sourceStream=null;activeCallId=null;
  processedDestination=null;sender=null;sourceTrack=null;remoteAudio=null;
}
async function attachBleep(){
  if(!bleepOn)return;
  const media=getCallMedia?.();
  const currentSender=media?.pc?.getSenders?.().find(item=>item.track?.kind==="audio");
  const original=currentSender?.track;
  if(!media?.callId||!original){status("Запикивание включено, ожидаю подключения аудио звонка.");return;}
  if(original.readyState==="ended")return;
  const ctx=await openContext();
  const destination=ctx.createMediaStreamDestination();
  let next;
  try{
    next=createContinuousBleep(ctx,new MediaStream([original]),destination);
    next.setEnabled(true);
    const track=destination.stream.getAudioTracks()[0];
    track.enabled=original.enabled;
    await currentSender.replaceTrack(track);
  }catch(error){
    next?.close();destination.stream.getTracks().forEach(track=>track.stop());
    throw error;
  }
  bleepChain=next;bleepSender=currentSender;bleepOriginal=original;
  bleepDestination=destination;bleepCallId=media.callId;
  status("Запикивание включено. Собеседник непрерывно слышит сигнал вместо вашего голоса.");
}
async function detachBleep(){
  const prior=bleepChain;
  if(!prior)return;
  prior.setEnabled(false); // Turn tone off synchronously.
  const oldSender=bleepSender,oldSource=bleepOriginal;
  const track=bleepDestination?.stream.getAudioTracks()[0];
  if(oldSender && oldSource?.readyState!=="ended" && oldSender.track===track)
    try{await oldSender.replaceTrack(oldSource);}catch{}
  prior.close();
  bleepDestination?.stream.getTracks().forEach(t=>t.stop());
  bleepChain=null;bleepSender=null;bleepOriginal=null;
  bleepDestination=null;bleepCallId=null;
}
export async function refreshVoiceLabCall(){
  if(state.enabled||bleepOn)await enqueue();
}
export function setVoiceLabMuted(muted){
  if(chainTarget==="outgoing"){
    const track=processedDestination?.stream.getAudioTracks()[0];
    if(track && track.readyState!=="ended")track.enabled=!muted;
  }
  const bleeper=bleepDestination?.stream.getAudioTracks()[0];
  if(bleeper && bleeper.readyState!=="ended")bleeper.enabled=!muted;
}
export async function pauseVoiceLabForMicSwitch(){
  await operation.catch(()=>{});
  await detachBleep();
  await stopProcessing();
}
export function stopVoiceLabCall(){
  bleepOn=false;bleepChain?.setEnabled(false);updateBleepControls();
  state.enabled=false;
  if(ui("enabled"))ui("enabled").checked=false;
  const dialog=ui("dialog");
  if(dialog?.open)dialog.close();
  void enqueue().then(async()=>{
    const old=context;context=null;
    try{await old?.close?.();}catch{}
  });
}
