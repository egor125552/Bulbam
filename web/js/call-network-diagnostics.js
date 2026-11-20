import {announce} from "./ui.js";
import {hasTurnCredentials,readIcePolicy,saveIcePolicy,selectedIceRoute} from "./call-ice-route.js";

let refs=null;
let getConnection=()=>null;
let fetchServers=async()=>[];
function setStatus(message){if(refs?.status)refs.status.textContent=message;}
export function updateCallRouteStats(stats){
  if(!refs?.route)return selectedIceRoute(stats);
  const route=selectedIceRoute(stats);
  refs.route.textContent=route.label;
  return route;
}
export function clearCallRouteStats(){
  if(refs?.route)refs.route.textContent="Звонка нет, маршрут не выбран";
}
export function setupCallNetworkDiagnostics({peerConnection,iceServers}){
  getConnection=peerConnection;
  fetchServers=iceServers;
  refs={
    route:document.querySelector("#call-ice-route"),
    available:document.querySelector("#call-turn-availability"),
    select:document.querySelector("#call-ice-mode"),
    status:document.querySelector("#call-ice-mode-status"),
    refresh:document.querySelector("#refresh-call-route")
  };
  if(!refs.select||!refs.refresh)return;
  refs.select.value=readIcePolicy();
  refs.select.addEventListener("change",async()=>{
    const proposed=refs.select.value;
    if(proposed==="relay"){
      refs.select.disabled=true;
      setStatus("Проверяю наличие TURN в серверных настройках…");
      let available=false;
      try{available=hasTurnCredentials(await fetchServers({refresh:true}));}catch{}
      refs.select.disabled=false;
      if(!available){
        refs.select.value=saveIcePolicy("all");
        if(refs.available)refs.available.textContent="TURN не предоставлен сервером";
        setStatus("Только TURN включить нельзя: сервер не выдал временные TURN-данные. Автоматический режим сохранён.");
        return;
      }
    }
    const value=saveIcePolicy(proposed);
    const msg=value==="relay"
      ?"Для следующего звонка выбран только TURN. Настройка временная, текущий звонок не меняется."
      :"Для следующего звонка выбран автоматический маршрут. Текущий звонок не меняется.";
    setStatus(msg);
    announce(msg);
  });
  refs.refresh.addEventListener("click",()=>void refreshCallNetworkDiagnostics());
}
export async function refreshCallNetworkDiagnostics(){
  if(!refs?.refresh)return;
  refs.refresh.disabled=true;
  try{
    const servers=await fetchServers({refresh:true});
    const turn=hasTurnCredentials(servers);
    if(refs.available)refs.available.textContent=turn
      ?"TURN выдан сервером (корректность маршрута проверяется во время звонка)"
      :"TURN не предоставлен сервером, доступен только прямой маршрут";
    const pc=getConnection();
    if(pc&&typeof pc.getStats==="function"){
      updateCallRouteStats(await pc.getStats());
    }else{
      clearCallRouteStats();
    }
    setStatus("Сетевые настройки и текущий маршрут проверены.");
  }catch(error){
    if(refs.available)refs.available.textContent="Не удалось проверить TURN";
    setStatus("Ошибка диагностики соединения: "+String(error?.message||error).slice(0,110));
  }finally{refs.refresh.disabled=false;}
}
