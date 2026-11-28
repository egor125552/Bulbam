import { logDiagnostic, describeApiOperation, logApiStart, logApiResult, logTraceEvent, diagnosticErrorName } from "./diagnostics-log.js";
import { language, translateText } from "./i18n.js";
const responseObservers = new Set();

const RETRYABLE_STATUSES = new Set([408, 502, 503, 504]);
const RETRY_DELAYS_MS = [450, 1100];

function defaultTimeoutMs(method) {
  return method === "GET" ? 12_000 : 20_000;
}

function canRetryRequest(path, method, options) {
  if (options.signal?.aborted) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  if (typeof options.retries === "number") return options.retries > 0;
  if (method !== "GET") return false;
  if (path === "/api/v1/presence" || path.startsWith("/api/v1/presence?")) return false;
  return true;
}

async function fetchWithTimeout(path, fetchOptions, timeoutMs) {
  const externalSignal = fetchOptions.signal;
  if ((!timeoutMs || timeoutMs <= 0) || typeof AbortController === "undefined") {
    return fetch(path, fetchOptions);
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else if (typeof externalSignal.addEventListener === "function") {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal && typeof externalSignal.removeEventListener === "function") {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function api(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const operation = describeApiOperation(path, method);
  const started = Date.now();
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : defaultTimeoutMs(method);
  const maxRetries = canRetryRequest(path, method, options)
    ? Math.max(0, Math.min(3, typeof options.retries === "number" ? options.retries : RETRY_DELAYS_MS.length))
    : 0;

  const { retries: _ignoredRetries, timeoutMs: _ignoredTimeout, ...rawFetchOptions } = options;
  const fetchOptions = {
    cache: "no-store",
    credentials: "same-origin",
    ...rawFetchOptions,
    headers: {
      accept: "application/json",
      "accept-language": language() === "be" ? "be" : "ru",
      ...(rawFetchOptions.body ? { "content-type": "application/json" } : {}),
      ...(rawFetchOptions.headers || {})
    }
  };

  logApiStart(operation);
  logTraceEvent('Сеть','API ожидание ответа','',{active:true});
  let response = null;
  let lastNetworkError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await fetchWithTimeout(path, fetchOptions, timeoutMs);
      if (attempt < maxRetries && RETRYABLE_STATUSES.has(response.status)) {
        const waitMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      lastNetworkError = null;
      break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt >= maxRetries || options.signal?.aborted || (typeof navigator !== "undefined" && navigator.onLine === false)) {
        break;
      }
      const waitMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  if (lastNetworkError || !response) {
    const error = lastNetworkError || new Error("Сеть недоступна.");
    logDiagnostic("Сервер", "сбой сети", operation);
    logTraceEvent('Ошибки','API ошибка транспорта',diagnosticErrorName(error),{durationMs:Date.now()-started});
    throw error;
  }
  logApiResult(operation, response.status, Date.now()-started);
  logTraceEvent('Сеть','API заголовки получены','',{status:response.status,durationMs:Date.now()-started});

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
    logDiagnostic('Ошибки','API ответ без JSON',operation);
  }

  if (!response.ok) {
    logTraceEvent('Ошибки','API ответ с ошибкой','',{status:response.status});
    const error = new Error(translateText(payload?.error?.message || `Ошибка HTTP ${response.status}`));
    error.code = payload?.error?.code || "request_failed";
    error.status = response.status;
    if (
      response.status === 401 &&
      error.code === "invalid_session" &&
      path !== "/api/v1/auth/me" &&
      path !== "/api/v1/auth/login" &&
      path !== "/api/v1/auth/register" &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new CustomEvent("bulbam:session-expired", { detail: { path } }));
    }
    throw error;
  }

  logDiagnostic('Сервер','API данные обработаны',operation);
  notifyResponseObservers({
    path,
    method,
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
