const MIN_EXPECTED_DURATION_MS = 2500;
const DEFAULT_PROBE_MS = 2000;
const SEEK_TIMEOUT_MS = 1200;

export function setupVoiceWebKitTimelineFix() {
  if (!isAppleWebKitVoiceEnvironment()) return;

  const attach = (audio) => {
    if (!(audio instanceof HTMLAudioElement) || !audio.dataset.voiceMessageId) return;
    if (audio.dataset.webkitTimelineFix) return;
    audio.dataset.webkitTimelineFix = "waiting";

    const tryPrime = () => {
      if (audio.dataset.webkitTimelineFix === "done" || audio.dataset.webkitTimelineFix === "priming") return;
      const expectedMs = expectedDurationMs(audio.dataset.voiceMessageId);
      if (expectedMs < MIN_EXPECTED_DURATION_MS) {
        audio.dataset.webkitTimelineFix = "done";
        return;
      }
      void primeTimeline(audio, expectedMs);
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) queueMicrotask(tryPrime);
    else audio.addEventListener("loadedmetadata", tryPrime, { once: true });
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

export function voiceTimelineProbeMs(expectedMs, restoreMs = 0) {
  const duration = Math.max(0, Number(expectedMs) || 0);
  if (duration < MIN_EXPECTED_DURATION_MS) return null;
  const restore = Math.max(0, Math.min(Number(restoreMs) || 0, duration - 50));
  let probe = Math.min(DEFAULT_PROBE_MS, duration - 100);
  if (Math.abs(probe - restore) < 250) probe = Math.min(duration - 100, restore + 1000);
  return Math.max(100, probe);
}

async function primeTimeline(audio, expectedMs) {
  const messageId = audio.dataset.voiceMessageId;
  const restoreMs = currentUiPositionMs(messageId);
  const probeMs = voiceTimelineProbeMs(expectedMs, restoreMs);
  if (probeMs == null) {
    audio.dataset.webkitTimelineFix = "done";
    return;
  }

  audio.dataset.webkitTimelineFix = "priming";
  try {
    await seekAndWait(audio, probeMs / 1000);
    await seekAndWait(audio, restoreMs / 1000);
  } catch {
    // Warm-up is best-effort: never block ordinary playback.
  } finally {
    audio.dataset.webkitTimelineFix = "done";
  }
}

function expectedDurationMs(messageId) {
  const progress = progressElement(messageId);
  return Math.max(0, Number(progress?.max) * 1000 || 0);
}

function currentUiPositionMs(messageId) {
  const progress = progressElement(messageId);
  return Math.max(0, Number(progress?.value) * 1000 || 0);
}

function progressElement(messageId) {
  if (!messageId) return null;
  const message = document.querySelector(`.message[data-message-id="${messageId}"]`);
  return message?.querySelector(".voice-progress") ?? null;
}

function seekAndWait(audio, seconds) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
    audio.addEventListener("seeked", finish, { once: true });
    try {
      audio.currentTime = Math.max(0, Number(seconds) || 0);
      if (!audio.seeking) queueMicrotask(finish);
    } catch {
      finish();
    }
  });
}
