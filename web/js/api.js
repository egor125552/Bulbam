export async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Ошибка HTTP ${response.status}`);
    error.code = payload?.error?.code || "request_failed";
    error.status = response.status;
    throw error;
  }

  return payload;
}

export function deviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "браузер";
  return `Web · ${platform}`;
}
