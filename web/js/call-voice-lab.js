import {VOICE_LAB_DEFAULTS,normalizeVoiceLabState,canUseLocalRussianRecognition,hasProfanity} from "./call-voice-lab-core.js";
import {makeVoiceLabChain} from "./call-voice-lab-audio.js";
import {announce} from "./ui.js";

const KEY="bulbam.experimental.voiceLab.v1";
const fields=["tremoloHz","reverb","radioNoise","interference","noiseFrequency","x","y","distance"];
const sliders=["tremoloHz","reverb","radioNoise","interference","noiseFrequency","x","y","distance"];
const ui=(name)=>typeof document==="undefined"?null:document.getElementById?.("voice-lab-"+name)??null;
let getCallMedia=()=>null;
let state=readSettings();
let context=null,chain=null,chainTarget=null,processedDestination=null;
let sourceStream=null,sender=null,sourceTrack=null,activeCallId=null;
let autoRecognition=null,autoActive=false;
let operation=Promise.resolve();
let remoteStream=null;
let remoteAudio=null;

function readSettings() {
  try { return normalizeVoiceLabState(JSON.parse(localStorage.getItem(KEY)||"{}")); }
  catch { return normalizeVoiceLabState(); }
}
function save() {
  const {autoBleep,enabled,...persisted}=state;
  try { localStorage.setItem(KEY,JSON.stringify(persisted)); } catch {}
}
function status(text){const el=ui("status");if(el)el.textContent=text;}
function helpMessage(){return "Настройки принадлежат этому устройству. Эффект своего голоса услышит собеседник, эффект его голоса услышите только вы.";}
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
    // iOS requires AudioContext.resume() to begin inside the user's tap,
    // not after an asynchronous WebRTC/media-availability callback.
    void openContext().then(()=>enqueue()).catch(error=>{
      state.enabled=false;ui("enabled").checked=false;
      status("Не удалось включить звуковые эффекты: "+error.message);
    });
  });
  for(const name of ["preset","target",...fields]){
    ui(name)?.addEventListener("change",()=>{
      state=normalizeVoiceLabState({...state,[name]:ui(name).value,enabled:state.enabled});
      save();refreshVisibility();enqueue();
    });
    if(fields.includes(name))ui(name)?.addEventListener("input",()=>{
      state=normalizeVoiceLabState({...state,[name]:ui(name).value,enabled:state.enabled});
      save();if(chain)chain.update(state);
      const value=ui(name+"-value");if(value)value.textContent=String(state[name]);
      if(name==="tremoloHz"&&ui("tremolo-period"))ui("tremolo-period").textContent=`Период тремоло: ${Math.round(1000/state.tremoloHz)} мс`;
    });
  }
  ui("reset")?.addEventListener("click",()=>{
    state={...VOICE_LAB_DEFAULTS};
    save();render();enqueue();
  });
  ui("bleep")?.addEventListener("click",()=>{if(!chain||chainTarget!=="outgoing"){
    status("Для ручного сигнала включите обработку своего голоса.");
    return;
  }chain.bleep();status("Звук замаскирован коротким сигналом.");});
  ui("auto")?.addEventListener("change",()=>void changeAuto());
  ui("auto").disabled=true;
  ui("auto").checked=false;
  void canUseLocalRussianRecognition().then(ok=>{
    const control=ui("auto");
    if(!control)return;
    control.dataset.supported=ok?"true":"false";
    control.disabled=!ok || state.target!=="outgoing";
    ui("auto-availability").textContent=ok
      ?"Локальное распознавание доступно. Возможны задержки и пропуски; не гарантирует скрытия каждого слова."
      :"Автоматическое запикивание недоступно: в браузере нет локального распознавания русской речи. Облачное распознавание не включаем ради приватности.";
  });
  render();
}
function render(){
  if(!ui("preset"))return;
  ui("preset").value=state.preset;
  ui("target").value=state.target;
  ui("enabled").checked=state.enabled;
  ui("auto").checked=autoActive;
  for(const name of sliders){
    ui(name).value=String(state[name]);
    const label=ui(name+"-value");if(label)label.textContent=String(state[name]);
  }
  if(ui("tremolo-period"))ui("tremolo-period").textContent=`Период тремоло: ${Math.round(1000/state.tremoloHz)} мс`;
  refreshVisibility();
}
function refreshVisibility(){
  for(const [name,presets] of [["tremolo-options",["tremolo"]],
    ["reverb-options",["reverb"]],["radio-options",["radio","interference"]]]){
    const root=ui(name);if(root)root.hidden=!presets.includes(state.preset);
  }
  ui("bleep").hidden=state.target!=="outgoing";
  ui("auto").disabled=state.target!=="outgoing" || ui("auto-availability")?.dataset?.supported!=="true";
}
function enqueue(){
  operation=operation.catch(()=>{}).then(async()=>{
    await applyCurrentSettings();
  }).catch(async error=>{
    state.enabled=false;ui("enabled").checked=false;
    status("Эффекты не применились, обычный звук сохранён: "+error.message);
    try{await stopProcessing();}catch{}
  });
  return operation;
}
async function openContext(){
  if(!context || context.state==="closed"){
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
  if(!state.enabled) {
    await stopProcessing();
    status("Эффекты выключены. Обычный звук звонка восстановлен.");
    return;
  }
  if(!media?.callId || !media.pc) {
    await stopProcessing();
    status("Эффекты будут доступны после подключения звука звонка.");
    return;
  }
  const stream=state.target==="outgoing"?media.localStream:media.remoteAudio?.srcObject;
  if(!stream?.getAudioTracks?.().length) {
    await stopProcessing();
    status("Ожидаю аудиодорожку. Можно продолжать звонок без эффектов.");
    return;
  }
  if(chain && chainTarget===state.target && activeCallId===media.callId && sourceStream===stream) {
    chain.update(state);return;
  }
  await stopProcessing();
  const ctx=await openContext();
  if(state.target==="remote"){
    remoteAudio=media.remoteAudio;
    remoteStream=stream;
    // The original HTML audio remains available for fallback, but is muted
    // only after a processing chain has successfully attached.
    chain=makeVoiceLabChain(ctx,stream,state,ctx.destination);
    chainTarget="remote";sourceStream=stream;activeCallId=media.callId;
    remoteAudio.muted=true;
    status("Слушаете собеседника с эффектом.");
  }else{
    sender=media.pc.getSenders().find(item=>item.track?.kind==="audio");
    sourceTrack=media.localStream?.getAudioTracks?.()[0];
    if(!sender||!sourceTrack)throw Error("Микрофон ещё не готов.");
    processedDestination=ctx.createMediaStreamDestination();
    const next=makeVoiceLabChain(ctx,media.localStream,state,processedDestination);
    const transformed=processedDestination.stream.getAudioTracks()[0];
    // Prevent generated radio hiss and bleep from leaking when call is muted.
    // The processed output mirrors mute state, and calls.js keeps it in sync.
    transformed.enabled=sourceTrack.enabled;
    try{await sender.replaceTrack(transformed);}
    catch(error){next.close();processedDestination.stream.getTracks().forEach(t=>t.stop());processedDestination=null;throw error;}
    chain=next;chainTarget="outgoing";sourceStream=media.localStream;activeCallId=media.callId;
    status("Ваш голос обрабатывается перед отправкой собеседнику.");
  }
}
async function stopProcessing(){
  stopAuto();
  const prior=chain,oldSender=sender,original=sourceTrack,target=chainTarget;
  if(target==="remote"&&remoteAudio)remoteAudio.muted=false;
  if(target==="outgoing" && oldSender && original?.readyState!=="ended"){
    try{await oldSender.replaceTrack(original);}catch{ /* An ended/replaced call cannot restore track. */ }
  }
  prior?.close();
  processedDestination?.stream.getTracks().forEach(track=>track.stop());
  chain=null;chainTarget=null;sourceStream=null;activeCallId=null;
  processedDestination=null;sender=null;sourceTrack=null;remoteAudio=null;remoteStream=null;
}
export async function refreshVoiceLabCall(){if(state.enabled)await enqueue();}
export function setVoiceLabMuted(muted){
  if(chainTarget!=="outgoing" || !processedDestination)return;
  const track=processedDestination.stream.getAudioTracks()[0];
  if(track?.readyState!=="ended")track.enabled=!muted;
}
export async function pauseVoiceLabForMicSwitch(){
  // Wait for any in-flight setup before restoring the raw microphone; no
  // old async replaceTrack may win the race after capture-profile replacement.
  await operation.catch(()=>{});
  if(chainTarget!=="outgoing")return;
  await stopProcessing();
}
export function stopVoiceLabCall(){
  state.enabled=false;autoActive=false;
  if(ui("enabled"))ui("enabled").checked=false;
  const dialog=ui("dialog");
  if(dialog?.open)dialog.close();
  // Cleanup belongs only to the experimental graph. Never stop localStream
  // or the remote WebRTC audio track, which are owned by calls.js.
  void enqueue().then(async()=>{
    const old=context;context=null;
    try{await old?.close?.();}catch{}
  });
}
// Local speech recognition is only best-effort. No external recognizer or
// cloud forwarding is enabled. Recognition results lack word timestamps and
// cannot guarantee an exact censor without a buffering/ASR pipeline.
async function changeAuto(){
  const control=ui("auto");
  if(!control.checked){stopAuto();status("Автоматическое запикивание выключено.");return;}
  if(state.target!=="outgoing"||chainTarget!=="outgoing"||ui("auto-availability")?.dataset?.supported!=="true"){
    control.checked=false;
    status("Автоматическое запикивание недоступно без локального распознавания и обработки вашего голоса.");
    return;
  }
  const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
  try{
    const speech=new Speech();
    speech.lang="ru-RU";speech.continuous=true;speech.interimResults=true;speech.processLocally=true;
    speech.onresult=(event)=>{
      for(let i=event.resultIndex;i<event.results.length;i++) {
        const text=event.results[i][0]?.transcript||"";
        if(hasProfanity(text)&&chainTarget==="outgoing")chain?.bleep(400);
      }
    };
    speech.onerror=(event)=>{status("Распознавание прервано: "+(event.error||"ошибка"));stopAuto();};
    speech.onend=()=>{if(autoActive) {autoActive=false;control.checked=false;status("Распознавание остановилось. Автоматическое запикивание выключено.");}};
    speech.start();autoRecognition=speech;autoActive=true;
    status("Экспериментальное распознавание включено. Из-за задержек слова могут прозвучать до сигнала.");
  }catch(error){control.checked=false;stopAuto();status("Не удалось включить локальное распознавание: "+error.message);}
}
function stopAuto(){
  autoActive=false;
  const old=autoRecognition;autoRecognition=null;
  if(ui("auto"))ui("auto").checked=false;
  if(old){old.onend=null;old.onerror=null;try{old.stop();}catch{}}
}
