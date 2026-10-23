// Short, bounded on-device call trace. Never include SDP, ICE candidates, IPs,
// TURN passwords, user IDs, names or microphone samples in this journal.
const MAX_LINES = 180;
const entries = [];
let listener = null;
let callNumber = 0;

const ALLOWED = new Set([
  "новый исходящий", "новый входящий", "звонок принят", "звонок отклонён",
  "звонок завершён", "звук соединён", "воспроизведение заблокировано",
  "запрос микрофона", "микрофон доступен", "подготовка WebRTC",
  "новый WebRTC создан", "WebRTC закрыт", "старый WebRTC отменён",
  "ICE конфигурация", "ICE ошибка", "ICE получен", "ICE отправлен",
  "ICE состояние", "WebRTC состояние", "сигнал получен", "сигнал отправлен",
  "сигнал ошибка", "сигнал проигнорирован", "начало согласования",
  "SDP предложение", "SDP ответ", "ожидание подключения", "таймер подключения истёк",
  "восстановление", "восстановление не удалось", "сеть недоступна",
  "проверка качества", "запрос TURN", "TURN недоступен", "пользовательский режим TURN",
  "пауза сигналов", "ошибка опроса", "устройство вернулось",
  "новый звонок", "состояние звонка", "очистка звонка", "смена аккаунта"
]);
const SAFE_DETAILS = /^[a-zа-яё0-9№ :(),./+_=-]{0,90}$/iu;

export function startCallTrace(direction) {
  callNumber++;
  logCallEvent("новый звонок", `№${callNumber}, ${direction === "incoming" ? "входящий" : "исходящий"}`);
}

export function logCallEvent(event, detail = "") {
  if (!ALLOWED.has(event)) return;
  const safe = String(detail).slice(0, 90);
  const sanitized = SAFE_DETAILS.test(safe) && !/\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{8}-[0-9a-f-]{27,}|(?:^|\s)(?:turn|stun):|candidate|secret|token|password|username|sdp|authorization|credential/i.test(safe) ? safe : "[данные скрыты]";
  const stamp = new Date().toLocaleTimeString("ru-RU", { hour12: false });
  entries.push(`${stamp} | ${event}${sanitized ? ": " + sanitized : ""}`);
  if (entries.length > MAX_LINES) entries.splice(0, entries.length - MAX_LINES);
  listener?.(getCallLogText());
}

export function getCallLogText() {
  return entries.join("\n");
}

export function subscribeCallLog(callback) {
  listener = callback;
  listener(getCallLogText());
  return () => { if (listener === callback) listener = null; };
}

export function clearCallLog() {
  entries.length = 0;
  listener?.("");
}
