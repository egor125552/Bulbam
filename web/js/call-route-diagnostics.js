// Browser-side WebRTC routing diagnostics. Deliberately never expose
// candidate IP addresses, TURN credentials or ICE usernames to the UI.
export const TEMP_TURN_KEY="bulbam.turn.only.session.v1";

export function hasTurnServer(iceServers=[]){
  return iceServers.some(server=>
    [server?.urls].flat(2).some(url=>/^turns?:/i.test(String(url||"")))
  );
}

export function iceTransportPolicy(iceServers,turnOnly){
  if(turnOnly&&!hasTurnServer(iceServers)){
    throw new Error("Режим TURN включён, но сервер не выдал TURN-адреса и временные учётные данные. Отключите «Только TURN» в диагностике или настройте TURN на сервере.");
  }
  return turnOnly?"relay":"all";
}

export function readTemporaryTurnMode(storage=globalThis.sessionStorage){
  try{return storage?.getItem(TEMP_TURN_KEY)==="1";}catch{return false;}
}

export function writeTemporaryTurnMode(enabled,storage=globalThis.sessionStorage){
  try{
    if(enabled)storage?.setItem(TEMP_TURN_KEY,"1");
    else storage?.removeItem(TEMP_TURN_KEY);
    return true;
  }catch{return false;}
}

export function selectedIceRoute(stats){
  if(!stats)return {kind:"unknown",label:"Маршрут пока не определён"};
  const values=typeof stats.values==="function"?[...stats.values()]:
    Array.isArray(stats)?stats:Object.values(stats);
  const get=id=>typeof stats.get==="function"?stats.get(id):values.find(x=>x?.id===id);
  const transport=values.find(item=>item.type==="transport"&&item.selectedCandidatePairId);
  const selected=transport?get(transport.selectedCandidatePairId):null;
  const pairs=values.filter(item=>item.type==="candidate-pair"&&item.state==="succeeded");
  const pair=selected??pairs.find(item=>item.selected===true)
    ??pairs.find(item=>item.nominated===true)??null;
  if(!pair)return {kind:"unknown",label:"ICE: маршрут ещё выбирается"};
  const local=get(pair.localCandidateId);
  const remote=get(pair.remoteCandidateId);
  const localType=local?.candidateType??"unknown";
  const remoteType=remote?.candidateType??"unknown";
  const protocol=String(local?.protocol??remote?.protocol??"").toUpperCase();
  const protocolLabel=protocol==="UDP"||protocol==="TCP"?" ("+protocol+")":"";
  if(localType==="relay"||remoteType==="relay")
    return {kind:"turn",label:"TURN: через сервер-ретранслятор"+protocolLabel,
      localType,remoteType};
  if(["srflx","prflx"].includes(localType)||["srflx","prflx"].includes(remoteType))
    return {kind:"stun",label:"Прямое соединение, обнаруженное через STUN"+protocolLabel,
      localType,remoteType};
  if(localType==="host"&&remoteType==="host")
    return {kind:"direct",label:"Прямое соединение (host)"+protocolLabel,
      localType,remoteType};
  return {kind:"unknown",label:"ICE: тип маршрута не определён",
    localType,remoteType};
}
