const READY_TIMEOUT_MS = 3000;
const objectUrls = new WeakMap();
const materializing = new WeakMap();

export function setupVoiceWebKitTimelineFix() {
  if (!isAppleWebKitVoiceEnvironment()) return;

  const attach = (audio) => {
    if (!(audio instanceof HTMLAudioElement) || !audio.dataset.voiceMessageId) return;
    if (audio.dataset.webkitTimelineFix) return;
    audio.dataset.webkitTimelineFix = "waiting";

    const startEarly = () => {
      if (audio.dataset.webkitTimelineFix !== "waiting") return;
      void ensureMaterialized(audio);
    };

    queueMicrotask(() => {
      const button = playButton(audio.dataset.voiceMessageId);
      button?.addEventListener("focus", startEarly, { once: true });
      button?.addEventListener("pointerdown", startEarly, { once: true, passive: true });
    });

    audio.addEventListener("play", (event) => {
      const state = audio.dataset.webkitTimelineFix;
      if (state === "done") return;

      event.stopImmediatePropagation();
      try { audio.pause(); } catch {}
      void ensureMaterialized(audio).then(() => audio.play().catch(() => undefined));
    }, { capture: true });

    audio.addEventListener("pause", (event) => {
      if (audio.dataset.webkitTimelineFix === "materializing") event.stopImmediatePropagation();
    }, { capture: true });
  };

  const cleanup = (audio) => {
    const url = objectUrls.get(audio);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(audio);
    materializing.delete(audio);
  };

  for (const audio of document.querySelectorAll("audio[data-voice-message-id]")) attach(audio);

  if (!window.MutationObserver) return;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.("audio[data-voice-message-id]")) attach(node);
        for (const audio of node.querySelectorAll?.("audio[data-voice-message-id]") ?? []) attach(audio);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.("audio[data-voice-message-id]")) cleanup(node);
        for (const audio of node.querySelectorAll?.("audio[data-voice-message-id]") ?? []) cleanup(audio);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function isAppleWebKitVoiceEnvironment(
  userAgent = navigator.userAgent ?? "",
  vendor = navigator.vendor ?? ""
) {
  const ua = String(userAgent);
  if (!/AppleWebKit/i.test(ua)) return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Apple/i.test(String(vendor)) && /Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua);
}

export function isWebMVoiceContentType(value) {
  return String(value ?? "").toLowerCase().split(";", 1)[0].trim() === "audio/webm";
}

function ensureMaterialized(audio) {
  if (audio.dataset.webkitTimelineFix === "done") return Promise.resolve();
  const existing = materializing.get(audio);
  if (existing) return existing;

  const promise = materialize(audio).finally(() => materializing.delete(audio));
  materializing.set(audio, promise);
  return promise;
}

async function materialize(audio) {
  const source = audio.currentSrc || audio.src;
  if (!source || source.startsWith("blob:")) {
    audio.dataset.webkitTimelineFix = "done";
    return;
  }

  audio.dataset.webkitTimelineFix = "materializing";
  const restoreSeconds = currentUiPositionSeconds(audio.dataset.voiceMessageId);

  try {
    const response = await fetch(source, {
      credentials: "same-origin",
      headers: { accept: "audio/*" },
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") ?? "";
    if (!isWebMVoiceContentType(contentType)) {
      try { await response.body?.cancel(); } catch {}
      audio.dataset.webkitTimelineFix = "done";
      return;
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error("empty voice asset");

    const previousUrl = objectUrls.get(audio);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const objectUrl = URL.createObjectURL(blob);
    objectUrls.set(audio, objectUrl);

    audio.src = objectUrl;
    audio.load();
    await waitForMetadata(audio);
    if (restoreSeconds > 0) {
      try { audio.currentTime = restoreSeconds; } catch {}
    }
  } catch {
    if (!audio.src || audio.src.startsWith("blob:")) audio.src = source;
  } finally {
    audio.dataset.webkitTimelineFix = "done";
  }
}

function playButton(messageId) {
  if (!messageId) return null;
  for (const message of document.querySelectorAll(".message[data-message-id]")) {
    if (message.dataset.messageId === messageId) return message.querySelector(".voice-actions button");
  }
  return null;
}

function currentUiPositionSeconds(messageId) {
  if (!messageId) return 0;
  for (const message of document.querySelectorAll(".message[data-message-id]")) {
    if (message.dataset.messageId !== messageId) continue;
    const progress = message.querySelector(".voice-progress");
    return Math.max(0, Number(progress?.value) || 0);
  }
  return 0;
}

function waitForMetadata(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", finish);
      audio.removeEventListener("canplay", finish);
      resolve();
    };
    const timer = setTimeout(finish, READY_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", finish, { once: true });
    audio.addEventListener("canplay", finish, { once: true });
  });
}
