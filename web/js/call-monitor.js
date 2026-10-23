// Independent presentation helpers for active call duration and connection diagnostics.
export function formatCallDuration(answeredAt, now = Date.now()) {
  const started = Number(answeredAt);
  if (!Number.isFinite(started) || started <= 0) return "00:00";
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const seconds = String(elapsed % 60).padStart(2, "0");
  const minutes = String(Math.floor(elapsed / 60) % 60).padStart(2, "0");
  const hours = Math.floor(elapsed / 3600);
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

export function turnAvailable(iceServers) {
  return Array.isArray(iceServers) && iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === "string" && /^turns?:/i.test(url));
  });
}

function selectedPair(stats) {
  const reports = [...stats.values()];
  const transport = reports.find((report) => report.type === "transport" && report.selectedCandidatePairId);
  if (transport) return stats.get(transport.selectedCandidatePairId);
  return reports.find((report) => report.type === "candidate-pair" &&
    (report.selected || (report.nominated && report.state === "succeeded")));
}

function routeText(stats) {
  const pair = selectedPair(stats);
  if (!pair) return "определяется";
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (local?.candidateType === "relay" || remote?.candidateType === "relay") return "через TURN-сервер";
  if (local?.candidateType || remote?.candidateType) return "прямое соединение";
  return "определяется";
}

export function describeCallDiagnostics(peer, stats) {
  const connection = peer?.connectionState || "неизвестно";
  const ice = peer?.iceConnectionState || "неизвестно";
  const parts = [`Соединение: ${connection}`, `ICE: ${ice}`];
  if (!stats || typeof stats.values !== "function" || typeof stats.get !== "function") {
    parts.push("Маршрут: определяется");
    return parts.join(". ") + ".";
  }
  parts.push(`Маршрут: ${routeText(stats)}`);
  const pair = selectedPair(stats);
  if (Number.isFinite(pair?.currentRoundTripTime)) {
    parts.push(`Задержка: ${Math.round(pair.currentRoundTripTime * 1000)} мс`);
  }
  const inbound = [...stats.values()].find((report) => report.type === "inbound-rtp" &&
    (report.kind ?? report.mediaType) === "audio" && !report.isRemote);
  if (inbound) {
    if (Number.isFinite(inbound.jitter)) parts.push(`Колебания задержки: ${Math.round(inbound.jitter * 1000)} мс`);
    if (Number.isFinite(inbound.packetsLost)) parts.push(`Потеряно пакетов: ${Math.max(0, inbound.packetsLost)}`);
  }
  // Never render candidate addresses, external IPs, user IDs or microphone details.
  return parts.join(". ") + ".";
}

const TURN_ONLY_SESSION_KEY="bulbam.turn.only.session.v1";

// The setting applies only to the current tab. It is never stored on the
// server and does not change the route of a call already in progress.
export function isTemporaryTurnOnly(storage=null){
  try{
    const target=storage??globalThis.sessionStorage;
    return target?.getItem(TURN_ONLY_SESSION_KEY)==="1";
  }catch{return false;}
}

export function setTemporaryTurnOnly(enabled,storage=null){
  try{
    const target=storage??globalThis.sessionStorage;
    if(enabled)target?.setItem(TURN_ONLY_SESSION_KEY,"1");
    else target?.removeItem(TURN_ONLY_SESSION_KEY);
    return true;
  }catch{return false;}
}

export function callIcePolicy(iceServers,turnOnly){
  if(turnOnly&&!turnAvailable(iceServers))
    throw new Error("TURN недоступен: сервер звонков не выдал данные для ретрансляции.");
  return turnOnly?"relay":"all";
}
