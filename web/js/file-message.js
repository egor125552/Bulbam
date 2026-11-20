import { translateText } from "./i18n.js";
import { announce } from "./ui.js";
import {
  buildFileUrl,
  fileExtensionLabel,
  formatFileSize,
  formatMediaDuration
} from "./file-format.js";

const AUDIO_SPEEDS = [1, 1.25, 1.5, 2];
const AUDIO_SPEED_KEY = "bulbam.audio.playbackRate";

const mediaCache = new Map();
let audioPlaybackRate = readAudioSpeed();
let lightboxTrigger = null;

export function setupFileMedia() {
  const dialog = document.querySelector("#media-lightbox");
  const closeButton = document.querySelector("#media-lightbox-close");
  closeButton?.addEventListener("click", () => dialog?.close?.());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog?.addEventListener("close", () => {
    const img = document.querySelector("#media-lightbox-image");
    if (img) img.removeAttribute("src");
    lightboxTrigger?.focus?.();
    lightboxTrigger = null;
  });

  window.addEventListener("bulbam:media-play", (event) => {
    const activeId = event.detail?.sourceId;
    for (const [key, entry] of mediaCache.entries()) {
      if (key === activeId) continue;
      if (entry.media && !entry.media.paused) {
        try { entry.media.pause(); } catch {}
      }
    }
  });
}

export function resetFileMedia() {
  for (const entry of mediaCache.values()) {
    entry.disposing = true;
    if (entry.media) {
      try { entry.media.pause(); } catch {}
      if (entry.detachedAudio) {
        entry.media.removeAttribute("src");
        try { entry.media.load(); } catch {}
        entry.media.remove();
      }
    }
  }
  mediaCache.clear();
  const dialog = document.querySelector("#media-lightbox");
  if (dialog?.open) dialog.close();
}

export function renderFileMessage(message, authorName = "") {
  const file = message.file;
  if (!file) return document.createElement("div");

  const existing = mediaCache.get(message.messageId);
  if (existing) {
    refreshCachedCard(existing, message, authorName);
    return existing.root;
  }

  let entry;
  if (file.mediaKind === "image") {
    entry = createImageCard(message);
  } else if (file.mediaKind === "video") {
    entry = createVideoCard(message);
  } else if (file.mediaKind === "audio") {
    entry = createAudioCard(message, authorName);
  } else {
    entry = createGenericFileCard(message);
  }

  mediaCache.set(message.messageId, entry);
  return entry.root;
}

function createImageCard(message) {
  const file = message.file;
  const viewUrl = buildFileUrl(message.conversationId, message.messageId);
  const downloadUrl = buildFileUrl(message.conversationId, message.messageId, { download: true });
  const sizeText = formatFileSize(file.sizeBytes);

  const root = document.createElement("section");
  root.className = "file-message file-image-card";
  root.setAttribute("aria-label", `${translateText("Фото")}: ${file.fileName}, ${sizeText}`);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "file-image-trigger";
  trigger.setAttribute("aria-label", `${translateText("Открыть фото на весь экран")}: ${file.fileName}`);

  const img = document.createElement("img");
  img.className = "file-image-preview";
  img.src = viewUrl;
  img.alt = `${translateText("Фото")}: ${file.fileName}`;
  img.loading = "lazy";
  img.decoding = "async";
  trigger.append(img);
  trigger.addEventListener("click", () => openImageLightbox(viewUrl, downloadUrl, file.fileName, sizeText, trigger));

  const footer = buildFileFooter(file.fileName, sizeText, downloadUrl);
  root.append(trigger, footer);
  const caption = appendCaption(root, message.text);

  return { root, kind: "image", caption, media: null, detachedAudio: false, disposing: false };
}

function createVideoCard(message) {
  const file = message.file;
  const streamUrl = buildFileUrl(message.conversationId, message.messageId);
  const downloadUrl = buildFileUrl(message.conversationId, message.messageId, { download: true });
  const sizeText = formatFileSize(file.sizeBytes);

  const root = document.createElement("section");
  root.className = "file-message file-video-card";
  root.setAttribute("aria-label", `${translateText("Видео")}: ${file.fileName}, ${sizeText}`);

  const video = document.createElement("video");
  video.className = "file-video-player";
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = streamUrl;
  video.setAttribute("aria-label", `${translateText("Видео")}: ${file.fileName}`);

  video.addEventListener("play", () => {
    window.dispatchEvent(new CustomEvent("bulbam:media-play", { detail: { sourceId: message.messageId } }));
  });
  video.addEventListener("error", () => {
    announce(`${translateText("Не удалось воспроизвести видео")} ${file.fileName}. ${translateText("Попробуйте скачать файл.")}`);
  });

  const footer = buildFileFooter(file.fileName, sizeText, downloadUrl);
  root.append(video, footer);
  const caption = appendCaption(root, message.text);

  return { root, kind: "video", caption, media: video, detachedAudio: false, disposing: false };
}

function createAudioCard(message, authorName) {
  const file = message.file;
  const streamUrl = buildFileUrl(message.conversationId, message.messageId);
  const downloadUrl = buildFileUrl(message.conversationId, message.messageId, { download: true });
  const sizeText = formatFileSize(file.sizeBytes);

  const root = document.createElement("section");
  root.className = "file-message file-audio-card";
  root.setAttribute("aria-label", `${translateText("Аудио")}: ${file.fileName}, ${sizeText}`);

  // Keep the HTMLAudioElement attached to document.body so chat list/receipt
  // rerenders never interrupt music playback on Safari/iOS or desktop.
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = streamUrl;
  audio.hidden = true;
  audio.setAttribute("aria-hidden", "true");
  audio.tabIndex = -1;
  audio.playbackRate = audioPlaybackRate;
  audio.dataset.fileAudioMessageId = message.messageId;
  document.body.append(audio);

  const header = document.createElement("div");
  header.className = "file-audio-header";

  const badge = document.createElement("span");
  badge.className = "file-ext-badge";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = fileExtensionLabel(file.fileName);

  const metaWrap = document.createElement("div");
  metaWrap.className = "file-info";
  const title = document.createElement("strong");
  title.className = "file-name";
  title.dataset.userContent = "true";
  title.textContent = file.fileName;
  const size = document.createElement("span");
  size.className = "file-size";
  size.textContent = sizeText;
  metaWrap.append(title, size);
  header.append(badge, metaWrap);

  const controls = document.createElement("div");
  controls.className = "file-audio-controls";

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "icon-button file-audio-play";
  playButton.dataset.icon = "play";
  playButton.textContent = translateText("Воспроизвести");
  playButton.setAttribute("aria-label", `${translateText("Воспроизвести")} ${file.fileName}`);

  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "icon-button";
  backButton.dataset.icon = "rewind";
  backButton.textContent = translateText("Назад на 15 секунд");
  backButton.setAttribute("aria-label", translateText("Назад на 15 секунд"));

  const forwardButton = document.createElement("button");
  forwardButton.type = "button";
  forwardButton.className = "icon-button";
  forwardButton.dataset.icon = "forward";
  forwardButton.textContent = translateText("Вперёд на 15 секунд");
  forwardButton.setAttribute("aria-label", translateText("Вперёд на 15 секунд"));

  const speedButton = document.createElement("button");
  speedButton.type = "button";
  speedButton.className = "file-audio-speed";
  speedButton.textContent = formatSpeedLabel(audioPlaybackRate);
  speedButton.setAttribute("aria-label", `${translateText("Скорость воспроизведения")}: ${formatSpeedLabel(audioPlaybackRate)}`);

  const downloadLink = createDownloadLink(downloadUrl, file.fileName, sizeText);

  controls.append(playButton, backButton, forwardButton, speedButton, downloadLink);

  const progress = document.createElement("input");
  progress.type = "range";
  progress.className = "file-audio-progress";
  progress.min = "0";
  progress.max = "100";
  progress.step = "0.2";
  progress.value = "0";
  progress.setAttribute("aria-label", `${translateText("Положение трека")} ${file.fileName}`);

  const timeLabel = document.createElement("span");
  timeLabel.className = "file-audio-time";
  timeLabel.textContent = "0:00 / —:—";

  root.append(header, controls, progress, timeLabel);
  const caption = appendCaption(root, message.text);

  const entry = {
    root,
    kind: "audio",
    caption,
    media: audio,
    playButton,
    speedButton,
    progress,
    timeLabel,
    fileName: file.fileName,
    authorName,
    detachedAudio: true,
    disposing: false
  };

  const syncTime = () => {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    if (duration > 0) {
      progress.max = String(duration);
      progress.value = String(Math.min(duration, current));
      const text = `${formatMediaDuration(current)} / ${formatMediaDuration(duration)}`;
      timeLabel.textContent = text;
      progress.setAttribute("aria-valuetext", `${formatMediaDuration(current)} ${translateText("из")} ${formatMediaDuration(duration)}`);
    } else {
      timeLabel.textContent = `${formatMediaDuration(current)} / —:—`;
    }
  };

  const seekBy = (deltaSec) => {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
    const next = Math.max(0, Math.min(duration, (audio.currentTime || 0) + deltaSec));
    try { audio.currentTime = next; } catch {}
    syncTime();
  };

  playButton.addEventListener("click", async () => {
    if (audio.paused) {
      window.dispatchEvent(new CustomEvent("bulbam:media-play", { detail: { sourceId: message.messageId } }));
      try {
        await audio.play();
      } catch {
        announce(`${translateText("Не удалось воспроизвести аудио")} ${file.fileName}.`);
      }
    } else {
      audio.pause();
    }
  });
  backButton.addEventListener("click", () => seekBy(-15));
  forwardButton.addEventListener("click", () => seekBy(15));
  speedButton.addEventListener("click", () => {
    const idx = AUDIO_SPEEDS.indexOf(audioPlaybackRate);
    audioPlaybackRate = AUDIO_SPEEDS[(idx + 1) % AUDIO_SPEEDS.length];
    try { localStorage.setItem(AUDIO_SPEED_KEY, String(audioPlaybackRate)); } catch {}
    for (const candidate of mediaCache.values()) {
      if (candidate.kind === "audio" && candidate.media) {
        candidate.media.playbackRate = audioPlaybackRate;
        candidate.speedButton.textContent = formatSpeedLabel(audioPlaybackRate);
        candidate.speedButton.setAttribute(
          "aria-label",
          `${translateText("Скорость воспроизведения")}: ${formatSpeedLabel(audioPlaybackRate)}`
        );
      }
    }
    announce(`${translateText("Скорость аудио")} ${formatSpeedLabel(audioPlaybackRate)}.`);
  });
  progress.addEventListener("input", () => {
    const target = Number(progress.value);
    if (Number.isFinite(target)) {
      try { audio.currentTime = target; } catch {}
      syncTime();
    }
  });
  progress.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(event.key === "ArrowLeft" ? -15 : 15);
    }
  });

  audio.addEventListener("loadedmetadata", syncTime);
  audio.addEventListener("durationchange", syncTime);
  audio.addEventListener("timeupdate", syncTime);
  audio.addEventListener("play", () => {
    if (entry.disposing) return;
    playButton.dataset.icon = "pause";
    playButton.textContent = translateText("Пауза");
    playButton.setAttribute("aria-label", `${translateText("Пауза")} ${file.fileName}`);
    updateMediaSession(audio, file.fileName, entry.authorName, seekBy);
  });
  audio.addEventListener("pause", () => {
    if (entry.disposing) return;
    playButton.dataset.icon = "play";
    playButton.textContent = translateText("Воспроизвести");
    playButton.setAttribute("aria-label", `${translateText("Воспроизвести")} ${file.fileName}`);
  });
  audio.addEventListener("ended", () => {
    if (entry.disposing) return;
    playButton.dataset.icon = "play";
    playButton.textContent = translateText("Воспроизвести");
    playButton.setAttribute("aria-label", `${translateText("Воспроизвести")} ${file.fileName}`);
  });
  audio.addEventListener("error", () => {
    if (entry.disposing) return;
    announce(`${translateText("Не удалось воспроизвести аудио")} ${file.fileName}. ${translateText("Попробуйте скачать файл.")}`);
  });

  return entry;
}

function createGenericFileCard(message) {
  const file = message.file;
  const downloadUrl = buildFileUrl(message.conversationId, message.messageId, { download: true });
  const sizeText = formatFileSize(file.sizeBytes);

  const root = document.createElement("section");
  root.className = "file-message file-generic-card";
  root.setAttribute("aria-label", `${translateText("Файл")}: ${file.fileName}, ${sizeText}`);

  const row = document.createElement("div");
  row.className = "file-generic-row";

  const badge = document.createElement("span");
  badge.className = "file-ext-badge";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = fileExtensionLabel(file.fileName);

  const info = document.createElement("div");
  info.className = "file-info";
  const name = document.createElement("strong");
  name.className = "file-name";
  name.dataset.userContent = "true";
  name.textContent = file.fileName;
  const size = document.createElement("span");
  size.className = "file-size";
  size.textContent = sizeText;
  info.append(name, size);

  const downloadLink = createDownloadLink(downloadUrl, file.fileName, sizeText);

  row.append(badge, info, downloadLink);
  root.append(row);
  const caption = appendCaption(root, message.text);

  return { root, kind: "file", caption, media: null, detachedAudio: false, disposing: false };
}

function buildFileFooter(fileName, sizeText, downloadUrl) {
  const footer = document.createElement("div");
  footer.className = "file-footer";

  const info = document.createElement("div");
  info.className = "file-info";
  const name = document.createElement("strong");
  name.className = "file-name";
  name.dataset.userContent = "true";
  name.textContent = fileName;
  const size = document.createElement("span");
  size.className = "file-size";
  size.textContent = sizeText;
  info.append(name, size);

  const downloadLink = createDownloadLink(downloadUrl, fileName, sizeText);
  footer.append(info, downloadLink);
  return footer;
}

function createDownloadLink(url, fileName, sizeText) {
  const link = document.createElement("a");
  link.className = "file-download-link button-with-icon";
  link.dataset.icon = "download";
  link.href = url;
  link.download = fileName;
  link.textContent = translateText("Скачать");
  link.setAttribute("aria-label", `${translateText("Скачать")} ${fileName}, ${sizeText}`);
  return link;
}

function appendCaption(root, text) {
  const clean = String(text ?? "").trim();
  if (!clean) return null;
  const p = document.createElement("p");
  p.className = "file-caption";
  p.dataset.userContent = "true";
  p.textContent = clean;
  root.append(p);
  return p;
}

function refreshCachedCard(entry, message, authorName) {
  if (entry.kind === "audio") {
    entry.authorName = authorName;
  }
  const clean = String(message.text ?? "").trim();
  if (clean && !entry.caption) {
    entry.caption = appendCaption(entry.root, clean);
  } else if (entry.caption) {
    entry.caption.textContent = clean;
  }
}

function openImageLightbox(viewUrl, downloadUrl, fileName, sizeText, trigger) {
  const dialog = document.querySelector("#media-lightbox");
  const img = document.querySelector("#media-lightbox-image");
  const title = document.querySelector("#media-lightbox-title");
  const meta = document.querySelector("#media-lightbox-meta");
  const download = document.querySelector("#media-lightbox-download");
  if (!dialog || !img) return;
  lightboxTrigger = trigger;
  img.src = viewUrl;
  img.alt = `${translateText("Фото")}: ${fileName}`;
  if (title) title.textContent = fileName;
  if (meta) meta.textContent = sizeText;
  if (download) {
    download.href = downloadUrl;
    download.download = fileName;
    download.setAttribute("aria-label", `${translateText("Скачать")} ${fileName}, ${sizeText}`);
  }
  dialog.showModal();
  document.querySelector("#media-lightbox-close")?.focus?.();
}

function updateMediaSession(audio, fileName, authorName, seekBy) {
  if (!("mediaSession" in navigator)) return;
  try {
    if (typeof window.MediaMetadata === "function") {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: fileName,
        artist: authorName || "Бульбам",
        album: "Бульбам"
      });
    }
    navigator.mediaSession.setActionHandler("play", () => void audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
    navigator.mediaSession.setActionHandler("seekforward", () => seekBy(15));
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
        try { audio.currentTime = details.seekTime; } catch {}
      }
    });
  } catch {
    // Some browsers restrict optional MediaSession actions.
  }
}

function formatSpeedLabel(rate) {
  return `${String(rate).replace(".", ",")}×`;
}

function readAudioSpeed() {
  try {
    const raw = Number(localStorage.getItem(AUDIO_SPEED_KEY));
    return AUDIO_SPEEDS.includes(raw) ? raw : 1;
  } catch {
    return 1;
  }
}
