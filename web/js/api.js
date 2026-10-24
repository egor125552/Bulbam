import { logDiagnostic, describeApiOperation, logApiStart, logApiResult } from "./diagnostics-log.js";
import { language, translateText } from "./i18n.js";
const responseObservers = new Set();

export async function api(path, options = {}) {
  const operation = describeApiOperation(path, String(options.method ?? "GET").toUpperCase());
  const started = Date.now();
  logApiStart(operation);
  let response;
  try {
    response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      accept: "application/json",
      "accept-language": language() === "be" ? "be" : "ru",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
    });
  } catch (error) {
    logDiagnostic("Сервер", "сбой сети", operation);
    throw error;
  }
  logApiResult(operation, response.status, Date.now()-started);

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(translateText(payload?.error?.message || `Ошибка HTTP ${response.status}`));
    error.code = payload?.error?.code || "request_failed";
    error.status = response.status;
    throw error;
  }

  notifyResponseObservers({
    path,
    method: String(options.method || "GET").toUpperCase(),
    payload
  });
  return payload;
}

export function observeApiResponses(observer) {
  if (typeof observer !== "function") return () => undefined;
  responseObservers.add(observer);
  return () => responseObservers.delete(observer);
}

function notifyResponseObservers(event) {
  for (const observer of responseObservers) {
    try {
      observer(event);
    } catch {
      // Observability helpers must never break the API request that produced the response.
    }
  }
}

export function deviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "браузер";
  return `Web · ${platform}`;
}
