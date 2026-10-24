// Opt-in exportable, memory-only technical trace. Never store or export names,
// IDs, URLs with tokens, message text, audio samples or request/response bodies.
const MAX_EVENTS = 900;
const events = [];
const observers = new Set();
const pollCounts = new Map();
const POLLS = new Set(["GET сигналы звонка", "GET состояние звонка", "GET присутствие"]);
const SAFE_TOKEN = /^[a-zа-яё0-9 _.,:()№/+\-=]{0,100}$/iu;
const CONFIDENTIAL = /(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{8}-[0-9a-f-]{27,}|(?:turns?|stun):|bearer|secret|token|password|cookie|authorization|credential|candidate|sdp|@|https?:\/\//i;
const CATEGORIES = new Set(["Звонки", "Интерфейс", "Навигация", "Сеть", "Сервер", "Голосовые", "Микрофон", "Ошибки"]);
function safe(value) {
  const v = String(value ?? "").slice(0, 100);
  return SAFE_TOKEN.test(v) && !CONFIDENTIAL.test(v) ? v : "[данные скрыты]";
}
export function logDiagnostic(category, action, detail = "") {
  if (!CATEGORIES.has(category)) return;
  // Call sites must supply a fixed code-defined event, never user content.
  const event = `${new Date().toISOString()} | ${category} | ${safe(action)}${detail ? ` | ${safe(detail)}` : ""}`;
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const observer of observers) { try { observer(event); } catch {} }
}
export function diagnosticText() { return events.join("\n"); }
export function clearDiagnostics() { pollCounts.clear(); events.length = 0; for (const f of observers) { try { f(null); } catch {} } }
export function subscribeDiagnostics(callback) { observers.add(callback); return () => observers.delete(callback); }
// Log all meaningful operations; group repetitive successful heartbeat GETs.
// A connected call otherwise generates three nearly identical lines per poll
// and pushes the actual errors out of the bounded log within minutes.
export function logApiStart(operation) {
  if (!POLLS.has(operation)) logDiagnostic("Сервер", "запрос", operation);
}
export function logApiResult(operation, status, durationMs) {
  const timing = `${Math.max(0, Math.round(durationMs))} ms`;
  if (status === 200 && POLLS.has(operation)) {
    const count = (pollCounts.get(operation) ?? 0) + 1;
    pollCounts.set(operation, count);
    if (count === 1) logDiagnostic("Сервер", "фоновый опрос", `${operation} 200 ${timing}`);
    else if (count % 10 === 0) logDiagnostic("Сервер", "фоновый опрос", `${operation} ${count} проверок 200`);
    return;
  }
  logDiagnostic("Сервер", "ответ", `${operation} ${status} ${timing}`);
}
export function diagnosticErrorName(reason) {
  const name = typeof reason?.name === "string" ? reason.name : "";
  const safeNames = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
    "NotReadableError", "NotAllowedError", "NotSupportedError", "NotFoundError",
    "OverconstrainedError", "InvalidModificationError", "AbortError", "InvalidStateError",
    "NetworkError", "OperationError", "SecurityError"
  ]);
  return safeNames.has(name) ? name : "OtherError";
}

// Identify API operations without revealing object IDs, search terms, or raw paths.
export function describeApiOperation(path, method = "GET") {
  const verb = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "REQUEST";
  let pathname = "";
  try { pathname = new URL(path, "https://bulbam.invalid").pathname; } catch {}
  let label = "другой запрос";
  if (pathname === "/api/v1/auth/me") label = "проверка сеанса";
  else if (/^\/api\/v1\/auth\//.test(pathname)) label = "авторизация";
  else if (pathname === "/api/health" || pathname === "/api/ready") label = "состояние сервера";
  else if (pathname === "/api/v1/calls/ice") label = "получение ICE и TURN";
  else if (/\/calls\/[^/]+\/signals$/.test(pathname)) label = "сигналы звонка";
  else if (/\/calls\/[^/]+\/answer$/.test(pathname)) label = "ответ на звонок";
  else if (/\/calls\/[^/]+\/end$/.test(pathname)) label = "завершение звонка";
  else if (/\/calls(?:\/|$)/.test(pathname)) label = "состояние звонка";
  else if (pathname === "/api/v1/presence" || pathname === "/api/v1/presence/settings") label = "присутствие";
  else if (pathname === "/api/v1/presence/heartbeat") label = "сигнал активности";
  else if (pathname === "/api/v1/calls/active") label = "активные звонки";
  else if (pathname === "/api/v1/voice/settings") label = "настройки голосовых";
  else if (/\/receipts\/(?:delivered|read)$/.test(pathname)) label = "подтверждение сообщений";
  else if (/\/voice\/uploads/.test(pathname)) label = "загрузка голосового";
  else if (/\/messages(?:\/|$)/.test(pathname)) label = "сообщения";
  else if (/\/chats(?:\/|$)/.test(pathname)) label = "чаты";
  else if (/\/sessions/.test(pathname)) label = "сеансы";
  else if (/\/push/.test(pathname)) label = "уведомления";
  return `${verb} ${label}`;
}

// Only fixed, audited function names leave the device. Never export error
// messages, raw stacks, file paths, line URLs, domain names or device labels.
const SAFE_CALL_STACK_FRAMES = new Set([
  "createPeerConnection", "ensurePeerConnection", "beginOfferIfNeeded",
  "restartOffer", "processSignal", "sendSignal", "answerCall",
  "startCall", "resumeRecoveredCall", "recoverCallConnection",
  "applyAudioProfileDuringCall", "replaceCallCapture",
  "applySelectedAudioProfileToTrack", "requestCallMicrophone",
  "prepareCallCues", "playCallCue", "prepareRingback", "startRingback",
  "sampleSender", "pollSignals", "pollCallState", "switchCallAudioProfile"
]);
export function diagnosticErrorOrigin(reason) {
  const stack = typeof reason?.stack === "string" ? reason.stack : "";
  for (const line of stack.split("\n").slice(0, 16)) {
    // Function names are extracted only from the beginning of a frame, not
    // from filenames, query parameters or untrusted error text.
    const frame = /^\s*(?:at\s+)?(?:async\s+)?([a-zA-Z][a-zA-Z0-9]*)\s*(?:@|\()/.exec(line);
    if (frame && SAFE_CALL_STACK_FRAMES.has(frame[1])) return frame[1];
  }
  return "unknown";
}
