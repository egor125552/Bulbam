self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The Service Worker has no localStorage. Keep the selected language per
// browser installation in IndexedDB so background push uses the right locale.
const LOCALE_DATABASE="bulbam-service-worker-locale";
function localeDatabase() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(LOCALE_DATABASE,1);
    request.onupgradeneeded=()=>request.result.createObjectStore("preferences");
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function saveLocale(locale) {
  const db=await localeDatabase();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction("preferences","readwrite");
    tx.objectStore("preferences").put(locale==="be"?"be":"ru","language");
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
  db.close();
}
async function preferredLocale() {
  try {
    const db=await localeDatabase();
    const value=await new Promise((resolve,reject)=>{
      const tx=db.transaction("preferences","readonly");
      const request=tx.objectStore("preferences").get("language");
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    db.close();
    return value==="be"?"be":"ru";
  }catch{return "ru";}
}
self.addEventListener("message",(event)=>{
  if(event.data?.type==="bulbam.locale") {
    event.waitUntil(saveLocale(event.data.locale).catch(()=>{}));
  }
});
function localizedNotification(data,locale) {
  if(locale!=="be")return {title:data.title||"Бульбам",body:data.body||""};
  if(data.kind==="call"){
    const title=String(data.title||"");
    const marker="Входящий звонок — ";
    return {
      title:title.startsWith(marker)?"Уваходны званок — "+title.slice(marker.length):title,
      body:"Націсніце, каб адкрыць Бульбам і адказаць."
    };
  }
  if(data.kind==="admin-recovery")return {
    title:"Бульбам: запыт аднаўлення",
    body:"Новая заяўка. Перш чым ухваліць, праверце асобу карыстальніка."
  };
  // Sender names and message previews are user content. Never translate them.
  return {title:data.title||"Бульбам",body:data.body||""};
}

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

  const message=localizedNotification(data,await preferredLocale());
  await self.registration.showNotification(message.title, {
    body: message.body,
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

// Public application shell only. Never cache authenticated /api endpoints,
// voice messages, WebSocket traffic, or user data.
const SHELL_CACHE = "bulbam-shell-904258698d34";
const STATIC_FILES = new Set(["/styles.css", "/canonical-ui.css", "/icon.svg"]);

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && new URL(response.url).origin === self.location.origin) {
          const cache = await caches.open(SHELL_CACHE);
          event.waitUntil(cache.put("/", response.clone()).catch(() => {}));
        }
        return response;
      } catch (error) {
        const cached = await caches.match("/");
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }
  // A content-hashed bundle cannot go stale; serve it directly from cache.
  if (/^\/boot\.[a-f0-9]{12}\.js$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) void cache.put(request, response.clone()).catch(() => {});
      return response;
    })());
    return;
  }
  // Styles are updated in the background; the current load is not blocked
  // by a conditional 304 request on a mobile radio.
  if (STATIC_FILES.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok) return cache.put(request, response.clone()).then(() => response);
        return response;
      });
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network;
    })());
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("bulbam-shell-") && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
  })());
});
