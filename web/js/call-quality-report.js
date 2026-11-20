// A self-contained, read-only diagnostic for a live audio call.
// It never captures audio, requests permissions or sends statistics to a server.
const MIN_AUDIO_PACKETS = 20;

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1).replace(".", ",")}%`;
}

export function describeCallQuality(stats) {
  let inbound = null;
  let remote = null;
  let pair = null;

  stats?.forEach?.((report) => {
    const kind = report.kind ?? report.mediaType;
    if (report.type === "inbound-rtp" && !report.isRemote && kind === "audio" && !inbound) {
      inbound = report;
    }
    if (report.type === "remote-inbound-rtp" && (kind === "audio" || !kind) && !remote) {
      remote = report;
    }
    if (report.type === "candidate-pair" && report.state === "succeeded" &&
      (!pair || (report.nominated && !pair.nominated))) {
      pair = report;
    }
  });

  const received = finiteNonnegative(inbound?.packetsReceived);
  const lost = finiteNonnegative(inbound?.packetsLost);
  const total = (received ?? 0) + (lost ?? 0);
  // One early packet loss must not be presented as a broken connection.
  if (received === null || total < MIN_AUDIO_PACKETS) {
    return {
      level: "unknown",
      text: "Для оценки входящего звука пока недостаточно данных. Повторите проверку через несколько секунд после начала разговора."
    };
  }

  const lossRate = lost === null ? null : lost / total;
  const jitter = finiteNonnegative(inbound?.jitter);
  const jitterMs = jitter === null ? null : jitter * 1000;
  const roundTrip = finiteNonnegative(remote?.roundTripTime) ??
    finiteNonnegative(pair?.currentRoundTripTime);
  const rttMs = roundTrip === null ? null : roundTrip * 1000;

  if (lossRate === null && jitterMs === null && rttMs === null) {
    return { level: "unknown", text: "Браузер не предоставил достаточных показателей качества связи." };
  }

  const severe = (lossRate !== null && lossRate >= 0.08) ||
    (jitterMs !== null && jitterMs >= 80) || (rttMs !== null && rttMs >= 450);
  const degraded = (lossRate !== null && lossRate >= 0.025) ||
    (jitterMs !== null && jitterMs >= 35) || (rttMs !== null && rttMs >= 250);
  const level = severe ? "poor" : degraded ? "unstable" : "good";
  const label = level === "poor" ? "плохое" :
    level === "unstable" ? "нестабильное" : "хорошее";

  const details = [];
  if (lossRate !== null) details.push(`потери звуковых пакетов ${formatPercent(lossRate)}`);
  if (jitterMs !== null) details.push(`колебания задержки ${Math.round(jitterMs)} мс`);
  if (rttMs !== null) details.push(`отклик сети ${Math.round(rttMs)} мс`);

  const advice = level === "good"
    ? "Показатели входящего звука в норме."
    : "Если звук прерывается, попробуйте более устойчивую сеть или подойдите ближе к роутеру.";
  return {
    level,
    text: `Качество входящего звука: ${label}. ${details.join("; ")}. ${advice} Это оценка вашего приёма звука, а не микрофона собеседника.`
  };
}

export function setupCallQualityReport({ button, status, getPeerConnection }) {
  if (!button || !status || typeof getPeerConnection !== "function") return null;

  async function check() {
    if (button.hidden || button.disabled) return;
    const connection = getPeerConnection();
    if (!connection || typeof connection.getStats !== "function") {
      status.textContent = "Проверка качества недоступна: браузер не предоставляет статистику звонка.";
      return;
    }
    const connected = connection.connectionState === "connected" ||
      connection.iceConnectionState === "connected" ||
      connection.iceConnectionState === "completed";
    if (!connected) {
      status.textContent = "Звук ещё соединяется или восстанавливается. Проверьте качество после подключения.";
      return;
    }

    button.disabled = true;
    status.textContent = "Проверяю входящий звук…";
    try {
      const stats = await connection.getStats();
      // A slow getStats() must never overwrite the status of a new or ended call.
      if (button.hidden || getPeerConnection() !== connection) return;
      status.textContent = describeCallQuality(stats).text;
    } catch {
      if (!button.hidden && getPeerConnection() === connection) {
        status.textContent = "Не получилось измерить качество связи в этом браузере.";
      }
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener("click", () => void check());
  return { check };
}
