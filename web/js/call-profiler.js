// High-precision monotonic call connection profiler.
// Tracks ONLY timing milestones, phase durations, ICE cache status, candidate
// categories (host/srflx/relay), route category (direct/TURN), and RTT.
// Never stores user IDs, names, IPs, SDP, ICE candidate strings, or credentials.

const MAX_HISTORY = 5;

const STAGE_LABELS = {
  start_clicked: "Нажатие «Позвонить»",
  answer_clicked: "Нажатие «Ответить»",
  mic_start: "Запрос микрофона",
  mic_ready: "Микрофон готов",
  mic_attached: "Микрофон подключён к звонку",
  ice_fetch_start: "Запрос TURN/ICE конфига",
  ice_fetch_done: "TURN/ICE конфиг получен",
  call_create_start: "HTTP создание звонка",
  call_create_done: "Звонок создан на сервере",
  prewarm_pc_ready: "Предпрогрев WebRTC завершён",
  call_answered: "Получено подтверждение ответа",
  answer_http_start: "HTTP отправка ответа",
  answer_http_done: "HTTP ответ принят сервером",
  pc_create_start: "Создание RTCPeerConnection",
  pc_created: "RTCPeerConnection создан",
  offer_create_start: "Генерация SDP offer",
  offer_local_set: "SDP offer применён локально",
  offer_send_start: "HTTP отправка SDP offer",
  offer_sent: "SDP offer отправлен",
  offer_received: "Получен SDP offer",
  offer_remote_set: "Удалённый SDP offer применён",
  answer_create_start: "Генерация SDP answer",
  answer_local_set: "SDP answer применён локально",
  answer_send_start: "HTTP отправка SDP answer",
  answer_sent: "SDP answer отправлен",
  answer_received: "Получен SDP answer",
  answer_remote_set: "Удалённый SDP answer применён",
  first_local_ice: "Первый локальный ICE-кандидат",
  first_ice_flush_start: "Первая отправка пачки ICE",
  first_ice_flush_done: "Первая пачка ICE отправлена",
  first_remote_ice: "Первый удалённый ICE-кандидат",
  ice_checking: "ICE проверка маршрутов (checking)",
  ice_connected: "ICE маршрут найден (connected)",
  pc_connecting: "WebRTC рукопожатие DTLS (connecting)",
  pc_connected: "WebRTC соединён (connected)",
  remote_track: "Удалённая аудиодорожка получена",
  first_audio_frame: "Первый входящий аудиопакет",
  call_ended: "Звонок завершён"
};

const SPAN_LABELS = {
  micMs: "Получение микрофона (getUserMedia + ограничения)",
  iceFetchMs: "Загрузка ICE/TURN конфига",
  callCreateHttpMs: "HTTP создание звонка",
  answerHttpMs: "HTTP подтверждение ответа (/answer)",
  pcCreateMs: "Создание PeerConnection и настройка отправителя",
  waitForOfferMs: "Ожидание SDP offer от звонящего",
  offerCreateMs: "Генерация и установка SDP offer",
  offerSendHttpMs: "HTTP отправка SDP offer",
  waitForAnswerMs: "Ожидание SDP answer от собеседника",
  answerCreateMs: "Генерация и установка SDP answer",
  answerSendHttpMs: "HTTP отправка SDP answer",
  firstIceBatchHoldMs: "Задержка первой пачки ICE в батчере",
  firstIceSendHttpMs: "HTTP отправка первой пачки ICE",
  iceCheckMs: "ICE проверка связности (checking → connected)",
  dtlsHandshakeMs: "DTLS-SRTP рукопожатие (ICE → WebRTC connected)",
  firstAudioAfterConnectMs: "Ожидание первого аудиопакета после connected"
};

const SAFE_META_TAG = /^[a-z0-9_.:/-]{1,32}$/i;

function roundMs(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function sanitizeTag(value) {
  const text = String(value ?? "").trim();
  return SAFE_META_TAG.test(text) ? text : null;
}

function spanBetween(marks, startKey, endKey) {
  const start = marks[startKey];
  const end = marks[endKey];
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (end < start) return null;
  return roundMs(end - start);
}

export function createCallProfiler({ now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) } = {}) {
  let sequence = 0;
  let active = null;
  const history = [];
  const listeners = new Set();

  function emit() {
    const snapshot = getLatest();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // Profiling listeners must never disrupt call signaling.
      }
    }
  }

  function start(direction, { kind = "direct" } = {}) {
    sequence += 1;
    const startedAt = now();
    const record = {
      id: sequence,
      direction: direction === "incoming" ? "incoming" : "outgoing",
      kind: kind === "group" ? "group" : "direct",
      startedAtWallIso: new Date().toISOString(),
      startedAt,
      anchorMark: direction === "incoming" ? "answer_clicked" : "call_answered",
      anchorAt: direction === "incoming" ? startedAt : null,
      marks: {},
      events: [],
      spans: {},
      openSpans: {},
      meta: {
        iceCacheHit: null,
        iceHasTurn: null,
        firstLocalIceType: null,
        firstIceBatchSize: null,
        route: null,
        rttMs: null,
        status: "in_progress",
        answerSource: null
      }
    };
    active = record;
    history.unshift(record);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    mark(direction === "incoming" ? "answer_clicked" : "start_clicked", record.id);
    return record.id;
  }

  function resolveRecord(sessionId) {
    if (!active) return null;
    if (sessionId != null && active.id !== sessionId) return null;
    return active;
  }

  function mark(stage, sessionId = null, { once = true, meta = null } = {}) {
    const record = resolveRecord(sessionId);
    if (!record || !(stage in STAGE_LABELS)) return false;
    if (once && stage in record.marks) return false;
    const t = now();
    if (!(stage in record.marks)) {
      record.marks[stage] = t;
    }
    if (stage === record.anchorMark && record.anchorAt === null) {
      record.anchorAt = t;
    }
    const cleanMeta = sanitizeTag(meta);
    record.events.push({
      stage,
      t,
      meta: cleanMeta
    });
    if (stage === "pc_connected") {
      record.meta.status = "connected";
    } else if (stage === "call_ended" && record.meta.status === "in_progress") {
      record.meta.status = "ended_before_connect";
    }
    emit();
    return true;
  }

  function startSpan(spanName, sessionId = null) {
    const record = resolveRecord(sessionId);
    if (!record || !(spanName in SPAN_LABELS)) return;
    if (spanName in record.spans || spanName in record.openSpans) return;
    record.openSpans[spanName] = now();
  }

  function endSpan(spanName, sessionId = null) {
    const record = resolveRecord(sessionId);
    if (!record || !(spanName in record.openSpans)) return null;
    const elapsed = roundMs(now() - record.openSpans[spanName]);
    delete record.openSpans[spanName];
    if (elapsed !== null) {
      record.spans[spanName] = elapsed;
      emit();
    }
    return elapsed;
  }

  function setMeta(patch, sessionId = null) {
    const record = resolveRecord(sessionId);
    if (!record || !patch || typeof patch !== "object") return;
    if (typeof patch.iceCacheHit === "boolean") record.meta.iceCacheHit = patch.iceCacheHit;
    if (typeof patch.iceHasTurn === "boolean") record.meta.iceHasTurn = patch.iceHasTurn;
    if (patch.firstLocalIceType) {
      const clean = sanitizeTag(patch.firstLocalIceType);
      if (clean && !record.meta.firstLocalIceType) record.meta.firstLocalIceType = clean;
    }
    if (Number.isInteger(patch.firstIceBatchSize) && patch.firstIceBatchSize > 0 && record.meta.firstIceBatchSize === null) {
      record.meta.firstIceBatchSize = patch.firstIceBatchSize;
    }
    if (patch.route === "direct" || patch.route === "turn") {
      record.meta.route = patch.route;
    }
    if (Number.isFinite(patch.rttMs) && patch.rttMs >= 0) {
      record.meta.rttMs = roundMs(patch.rttMs);
    }
    if (patch.answerSource === "ws" || patch.answerSource === "poll") {
      record.meta.answerSource = patch.answerSource;
    }
    if (patch.status === "failed" && record.meta.status === "in_progress") {
      record.meta.status = "failed";
    }
    emit();
  }

  function computeSnapshot(record) {
    if (!record) return null;
    const anchor = record.anchorAt ?? record.startedAt;
    const marks = record.marks;
    const computedSpans = { ...record.spans };

    const derivedPairs = [
      ["micMs", "mic_start", "mic_ready"],
      ["iceFetchMs", "ice_fetch_start", "ice_fetch_done"],
      ["callCreateHttpMs", "call_create_start", "call_create_done"],
      ["answerHttpMs", "answer_http_start", "answer_http_done"],
      ["pcCreateMs", "pc_create_start", "pc_created"],
      ["waitForOfferMs", "answer_http_done", "offer_received"],
      ["offerCreateMs", "offer_create_start", "offer_local_set"],
      ["offerSendHttpMs", "offer_send_start", "offer_sent"],
      ["waitForAnswerMs", "offer_sent", "answer_received"],
      ["answerCreateMs", "answer_create_start", "answer_local_set"],
      ["answerSendHttpMs", "answer_send_start", "answer_sent"],
      ["firstIceBatchHoldMs", "first_local_ice", "first_ice_flush_start"],
      ["firstIceSendHttpMs", "first_ice_flush_start", "first_ice_flush_done"],
      ["iceCheckMs", "ice_checking", "ice_connected"],
      ["dtlsHandshakeMs", "ice_connected", "pc_connected"],
      ["firstAudioAfterConnectMs", "pc_connected", "first_audio_frame"]
    ];

    const spanEndMarks = Object.fromEntries(derivedPairs.map(([key, , endKey]) => [key, endKey]));

    for (const [key, startKey, endKey] of derivedPairs) {
      if (computedSpans[key] == null) {
        if (key === "waitForAnswerMs" && record.direction === "outgoing" && typeof marks.call_answered === "number" && typeof marks.offer_sent === "number" && typeof marks.answer_received === "number") {
          // When caller sends a pre-offer during ringing, waiting for the SDP answer
          // after the callee actually answers starts at max(offer_sent, call_answered).
          const effectiveStart = Math.max(marks.offer_sent, marks.call_answered);
          if (marks.answer_received >= effectiveStart) {
            computedSpans[key] = roundMs(marks.answer_received - effectiveStart);
          }
          continue;
        }
        const value = spanBetween(marks, startKey, endKey);
        if (value !== null) computedSpans[key] = value;
      }
    }

    const totalConnectMs = typeof marks.pc_connected === "number" && typeof anchor === "number"
      ? roundMs(marks.pc_connected - anchor)
      : null;
    const totalToFirstAudioMs = typeof marks.first_audio_frame === "number" && typeof anchor === "number"
      ? roundMs(marks.first_audio_frame - anchor)
      : null;
    const ringingWaitMs = record.direction === "outgoing"
      ? spanBetween(marks, "call_create_done", "call_answered")
      : null;

    // Rank post-anchor contributors to highlight where time actually went after
    // the call was answered (excluding pre-offer/prewarm work completed during ringing).
    const postAnchorKeys = record.direction === "incoming"
      ? ["micMs", "answerHttpMs", "pcCreateMs", "iceFetchMs", "waitForOfferMs", "answerCreateMs", "answerSendHttpMs", "firstIceBatchHoldMs", "iceCheckMs", "dtlsHandshakeMs", "firstAudioAfterConnectMs"]
      : ["pcCreateMs", "iceFetchMs", "offerCreateMs", "offerSendHttpMs", "waitForAnswerMs", "firstIceBatchHoldMs", "iceCheckMs", "dtlsHandshakeMs", "firstAudioAfterConnectMs"];

    const bottlenecks = postAnchorKeys
      .filter((key) => {
        if (typeof computedSpans[key] !== "number" || computedSpans[key] <= 0) return false;
        if (record.direction === "outgoing" && typeof anchor === "number") {
          const endMark = spanEndMarks[key];
          if (endMark && typeof marks[endMark] === "number" && marks[endMark] <= anchor) {
            return false;
          }
        }
        return true;
      })
      .map((key) => ({
        key,
        label: SPAN_LABELS[key],
        ms: computedSpans[key],
        sharePct: totalConnectMs && totalConnectMs > 0
          ? Math.min(100, Math.round((computedSpans[key] / totalConnectMs) * 100))
          : null
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 4);

    let prevT = null;
    const timeline = record.events.map((event) => {
      const fromAnchorMs = typeof anchor === "number" ? Math.round(event.t - anchor) : Math.round(event.t - record.startedAt);
      const deltaMs = prevT === null ? 0 : Math.max(0, Math.round(event.t - prevT));
      prevT = event.t;
      return {
        stage: event.stage,
        label: STAGE_LABELS[event.stage] ?? event.stage,
        fromAnchorMs,
        deltaMs,
        meta: event.meta
      };
    });

    return {
      id: record.id,
      direction: record.direction,
      kind: record.kind,
      startedAtWallIso: record.startedAtWallIso,
      status: record.meta.status,
      totalConnectMs,
      totalToFirstAudioMs,
      ringingWaitMs,
      meta: { ...record.meta },
      spans: computedSpans,
      bottlenecks,
      timeline
    };
  }

  function getActiveId() {
    return active?.id ?? null;
  }

  function getLatest() {
    return active ? computeSnapshot(active) : (history[0] ? computeSnapshot(history[0]) : null);
  }

  function getHistory() {
    return history.map(computeSnapshot);
  }

  function clear() {
    active = null;
    history.length = 0;
    emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    mark,
    startSpan,
    endSpan,
    setMeta,
    getActiveId,
    getLatest,
    getHistory,
    clear,
    subscribe
  };
}

export function formatCallProfileReport(profile, translate = (text) => text) {
  if (!profile) {
    return translate("Профиль соединения появится после первого звонка в этой вкладке.");
  }
  const t = (text) => translate(text);
  const lines = [];
  const directionText = profile.direction === "incoming" ? t("входящий") : t("исходящий");
  const statusMap = {
    connected: t("соединён"),
    in_progress: t("идёт соединение"),
    ended_before_connect: t("завершён до соединения"),
    failed: t("ошибка соединения")
  };
  const statusText = statusMap[profile.status] ?? t("идёт соединение");
  lines.push(`${t("Звонок")} #${profile.id} (${directionText}) — ${statusText}.`);

  if (profile.totalConnectMs !== null) {
    lines.push(`${t("Итого до WebRTC connected")}: ${profile.totalConnectMs} ${t("мс")}.`);
  }
  if (profile.totalToFirstAudioMs !== null) {
    lines.push(`${t("Итого до первого аудиопакета")}: ${profile.totalToFirstAudioMs} ${t("мс")}.`);
  }
  if (profile.ringingWaitMs !== null) {
    lines.push(`${t("Ожидание ответа (гудки)")}: ${profile.ringingWaitMs} ${t("мс")}.`);
  }

  const routeParts = [];
  if (profile.meta.route === "turn") routeParts.push(t("через TURN-сервер"));
  else if (profile.meta.route === "direct") routeParts.push(t("прямое соединение"));
  if (profile.meta.rttMs !== null) routeParts.push(`RTT ${profile.meta.rttMs} ${t("мс")}`);
  if (profile.meta.iceCacheHit !== null) {
    routeParts.push(profile.meta.iceCacheHit ? t("ICE из кэша") : t("ICE загружен по сети"));
  }
  if (profile.meta.firstLocalIceType) {
    routeParts.push(`${t("первый ICE")}: ${profile.meta.firstLocalIceType}`);
  }
  if (routeParts.length) {
    lines.push(`${t("Маршрут и параметры")}: ${routeParts.join(", ")}.`);
  }

  if (profile.bottlenecks.length) {
    lines.push("");
    lines.push(`${t("Главные задержки")}:`);
    for (const item of profile.bottlenecks) {
      const share = item.sharePct !== null ? ` (${item.sharePct}%)` : "";
      lines.push(`- ${t(item.label)}: ${item.ms} ${t("мс")}${share}`);
    }
  }

  const spanEntries = Object.entries(profile.spans).filter(([, value]) => typeof value === "number");
  if (spanEntries.length) {
    lines.push("");
    lines.push(`${t("Длительности этапов")}:`);
    for (const [key, value] of spanEntries) {
      const label = SPAN_LABELS[key] ?? key;
      lines.push(`- ${t(label)}: ${value} ${t("мс")}`);
    }
  }

  if (profile.timeline.length) {
    lines.push("");
    lines.push(`${t("Хронология от точки ответа")}:`);
    for (const item of profile.timeline) {
      const sign = item.fromAnchorMs >= 0 ? "+" : "";
      const metaPart = item.meta ? ` [${item.meta}]` : "";
      lines.push(`- ${sign}${item.fromAnchorMs} ${t("мс")} (+${item.deltaMs} ${t("мс")}): ${t(item.label)}${metaPart}`);
    }
  }

  return lines.join("\n");
}

export function formatCallProfileCompact(profile) {
  if (!profile || profile.totalConnectMs === null) return "";
  const top = profile.bottlenecks[0];
  const parts = [`всего ${profile.totalConnectMs}ms`];
  if (profile.totalToFirstAudioMs !== null) parts.push(`аудио ${profile.totalToFirstAudioMs}ms`);
  if (profile.meta.route) parts.push(profile.meta.route);
  if (top) parts.push(`${top.key}=${top.ms}ms`);
  return parts.join(", ").slice(0, 90);
}

export const callProfiler = createCallProfiler();
