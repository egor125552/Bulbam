self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Бульбам", body: event.data.text() };
  }

  event.waitUntil(handlePush(data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || "/";
  const target = new URL(rawUrl, self.location.origin);
  if (target.origin !== self.location.origin) return;

  event.waitUntil(openOrFocus(target.href));
});

async function handlePush(data) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });
  const visibleClients = windowClients.filter(
    (client) => client.url.startsWith(self.location.origin) && client.visibilityState === "visible"
  );

  if (data.kind === "call" && visibleClients.length) {
    // Realtime is normally the foreground path. Push is still sent server-side
    // for reliability; when the app is genuinely visible, use it only as a
    // second delivery path and avoid a duplicate system notification.
    for (const client of visibleClients) {
      client.postMessage({ type: "bulbam.call-push", data: data.data || {} });
    }
    return;
  }

  await self.registration.showNotification(data.title || "Бульбам", {
    body: data.body || "",
    icon: data.icon || "/icon.svg",
    tag: data.tag,
    data: data.data || { url: "/" }
  });

  if (data.kind === "message" && typeof self.navigator?.setAppBadge === "function") {
    try { await self.navigator.setAppBadge(); } catch {}
  }
}

async function openOrFocus(targetUrl) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  for (const client of windowClients) {
    if (!client.url.startsWith(self.location.origin)) continue;
    try {
      if ("navigate" in client) await client.navigate(targetUrl);
    } catch {
      // If navigation is unavailable, focusing the existing Bulbam window is still safe.
    }
    if ("focus" in client) return client.focus();
  }

  return self.clients.openWindow(targetUrl);
}
