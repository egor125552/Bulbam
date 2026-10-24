// Opt-in exportable, memory-only technical trace. Never store or export names,
// IDs, URLs with tokens, message text, audio samples or request/response bodies.
const MAX_EVENTS = 900;
const events = [];
const observers = new Set();
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
export function clearDiagnostics() { events.length = 0; for (const f of observers) { try { f(null); } catch {} } }
export function subscribeDiagnostics(callback) { observers.add(callback); return () => observers.delete(callback); }
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
  else if (/\/voice\/uploads/.test(pathname)) label = "загрузка голосового";
  else if (/\/messages(?:\/|$)/.test(pathname)) label = "сообщения";
  else if (/\/chats(?:\/|$)/.test(pathname)) label = "чаты";
  else if (/\/sessions/.test(pathname)) label = "сеансы";
  else if (/\/push/.test(pathname)) label = "уведомления";
  return `${verb} ${label}`;
}
