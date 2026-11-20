// Report the *selected* ICE candidate pair, never assume STUN or TURN from
// the list of configured servers. Avoid exposing peer IPs or ICE credentials.
const KEY="bulbam.calls.temporaryIcePolicy";
const normalize=policy=>policy==="relay"?"relay":"all";

export function readIcePolicy(storage) {
  try {
    const store=storage??globalThis.sessionStorage;
    return normalize(store.getItem(KEY));
  }catch{return "all";}
}

export function saveIcePolicy(policy,storage) {
  const value=normalize(policy);
  try{(storage??globalThis.sessionStorage).setItem(KEY,value);}catch{}
  return value;
}

export function hasTurnCredentials(servers) {
  return Array.isArray(servers)&&servers.some(server=>{
    if(typeof server?.username!=="string"||!server.username.trim()
      ||typeof server?.credential!=="string"||!server.credential.trim())return false;
    const urls=Array.isArray(server.urls)?server.urls:[server.urls];
    return urls.some(url=>typeof url==="string"&&/^turns?:/i.test(url));
  });
}

export function selectedIceRoute(stats) {
  const unknown={kind:"pending",label:"Соединение ещё не установлено"};
  if(!stats||typeof stats.forEach!=="function")return unknown;
  const byId=new Map();
  let selectedId=null;
  let nominated=null;
  stats.forEach(report=>{
    if(!report||typeof report!=="object")return;
    if(report.id)byId.set(report.id,report);
    if(report.type==="transport"&&report.selectedCandidatePairId)
      selectedId=report.selectedCandidatePairId;
    if(report.type==="candidate-pair"&&report.state==="succeeded"
      &&(report.selected===true||report.nominated)){
      if(!nominated||report.selected===true)nominated=report;
    }
  });
  const pair=selectedId?byId.get(selectedId):nominated;
  if(!pair||pair.type!=="candidate-pair"||pair.state!=="succeeded")return unknown;
  const local=byId.get(pair.localCandidateId)?.candidateType;
  const remote=byId.get(pair.remoteCandidateId)?.candidateType;
  if(!local||!remote)return unknown;
  const types=[local,remote];
  const rtt=Number(pair.currentRoundTripTime);
  const rttMs=Number.isFinite(rtt)&&rtt>=0?Math.round(rtt*1000):null;
  const suffix=rttMs===null?"":` · задержка сети ${rttMs} мс`;
  if(types.includes("relay"))return {kind:"turn",label:"TURN: через сервер-ретранслятор"+suffix,localType:local,remoteType:remote,rttMs};
  if(types.includes("srflx"))return {kind:"stun",label:"STUN: прямое соединение через NAT"+suffix,localType:local,remoteType:remote,rttMs};
  if(types.includes("prflx"))return {kind:"direct",label:"Прямое ICE-соединение"+suffix,localType:local,remoteType:remote,rttMs};
  if(types.every(type=>type==="host"))return {kind:"direct",label:"Прямое соединение"+suffix,localType:local,remoteType:remote,rttMs};
  return {kind:"unknown",label:"Тип маршрута не определён",localType:local,remoteType:remote,rttMs};
}
