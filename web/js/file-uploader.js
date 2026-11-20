import { api } from "./api.js";
import { logDiagnostic } from "./diagnostics-log.js";
import { translateText } from "./i18n.js";
import {
  acceptExternalMessage,
  getSelectedChat,
  refreshChatsAfterExternalMessage
} from "./messenger.js";
import { announce, elements, getCurrentAccount } from "./ui.js";
import {
  computeUploadProgress,
  formatFileSize,
  formatTransferSpeed
} from "./file-format.js";

const MAX_CLIENT_FILE_BYTES = 512 * 1024 * 1024;
const PARALLEL_CHUNKS = 4;
const CHUNK_RETRIES = 3;
const VOICEOVER_MILESTONES = [25, 50, 75];

const activeUploads = new Map();

export function setupFileUploader() {
  const attachButton = elements.fileAttachButton;
  const fileInput = elements.fileInput;
  if (!attachButton || !fileInput) return;

  attachButton.addEventListener("click", () => {
    if (!getCurrentAccount() || !getSelectedChat()) {
      announce("Сначала откройте чат, чтобы отправить файл.");
      return;
    }
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    if (!files.length) return;
    queueSelectedFiles(files);
  });

  // Allow pasting screenshots or files directly into the message input.
  elements.messageInput?.addEventListener("paste", (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const pastedFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!pastedFiles.length) return;
    if (!getCurrentAccount() || !getSelectedChat()) return;
    event.preventDefault();
    queueSelectedFiles(pastedFiles);
  });

  // Allow drag-and-drop onto the open conversation pane.
  const pane = document.querySelector(".conversation-pane");
  if (pane) {
    let dragDepth = 0;
    pane.addEventListener("dragenter", (event) => {
      if (!hasFiles(event) || !getSelectedChat()) return;
      event.preventDefault();
      dragDepth += 1;
      pane.classList.add("is-drop-target");
    });
    pane.addEventListener("dragover", (event) => {
      if (!hasFiles(event) || !getSelectedChat()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    pane.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) pane.classList.remove("is-drop-target");
    });
    pane.addEventListener("drop", (event) => {
      dragDepth = 0;
      pane.classList.remove("is-drop-target");
      if (!hasFiles(event) || !getSelectedChat()) return;
      event.preventDefault();
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (dropped.length) queueSelectedFiles(dropped);
    });
  }

  window.addEventListener("bulbam:account-changed", (event) => {
    if (!event.detail?.account) cancelAllUploads();
  });
}

function queueSelectedFiles(files) {
  const account = getCurrentAccount();
  const chat = getSelectedChat();
  if (!account || !chat) return;

  const captionText = elements.messageInput?.value.replace(/\r\n?/g, "\n").trim() ?? "";
  let captionConsumed = false;

  for (const file of files) {
    if (!file || file.size <= 0) {
      announce(`Файл ${file?.name || ""} пустой и не может быть отправлен.`);
      continue;
    }
    if (file.size > MAX_CLIENT_FILE_BYTES) {
      announce(`Файл ${file.name} превышает ограничение 512 МБ.`);
      continue;
    }

    const caption = !captionConsumed && captionText ? captionText : "";
    if (caption) {
      captionConsumed = true;
      elements.messageInput.value = "";
      elements.messageInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const job = createUploadJob(chat.conversationId, file, caption);
    activeUploads.set(job.id, job);
    renderUploadPanel();
    void runUploadJob(job);
  }
}

function createUploadJob(conversationId, file, caption) {
  return {
    id: randomId(),
    clientMessageId: randomId(),
    conversationId,
    file,
    caption,
    sessionId: null,
    chunkSizeBytes: 1024 * 1024,
    partCount: 1,
    confirmedParts: new Set(),
    partLoadedBytes: new Map(),
    activeXhrs: new Set(),
    status: "uploading", // uploading | completing | failed | cancelled
    errorMessage: "",
    percent: 0,
    loadedBytes: 0,
    speedBps: 0,
    startedAt: Date.now(),
    lastSpeedSampleAt: Date.now(),
    lastSpeedSampleBytes: 0,
    lastProgressRenderAt: 0,
    announcedMilestones: new Set(),
    lastAnnouncedAt: 0,
    ui: null
  };
}

async function runUploadJob(job) {
  job.status = "uploading";
  job.errorMessage = "";
  job.startedAt = Date.now();
  job.lastSpeedSampleAt = Date.now();
  job.lastSpeedSampleBytes = job.loadedBytes;
  updateJobUi(job);
  announce(`Загрузка файла ${job.file.name}, ${formatFileSize(job.file.size)}.`);
  logDiagnostic("Файлы", "начало загрузки файла");

  try {
    if (!job.sessionId) {
      const started = await api(`/api/v1/chats/${job.conversationId}/files/uploads`, {
        method: "POST",
        body: JSON.stringify({
          fileName: job.file.name || "file",
          mimeType: job.file.type || "application/octet-stream",
          sizeBytes: job.file.size
        })
      });
      if (job.status === "cancelled") {
        void abortSession(job.conversationId, started.upload.sessionId);
        return;
      }
      job.sessionId = started.upload.sessionId;
      job.chunkSizeBytes = started.upload.chunkSizeBytes;
      job.partCount = Math.ceil(job.file.size / job.chunkSizeBytes);
      for (const part of started.upload.receivedParts ?? []) {
        job.confirmedParts.add(part);
        job.partLoadedBytes.set(part, partByteLength(job.file.size, job.chunkSizeBytes, part));
      }
    } else {
      // Resuming after a transient error: ask server which chunks already persisted.
      const inspected = await api(
        `/api/v1/chats/${job.conversationId}/files/uploads/${job.sessionId}`
      );
      if (job.status === "cancelled") return;
      for (const part of inspected.upload.receivedParts ?? []) {
        job.confirmedParts.add(part);
        job.partLoadedBytes.set(part, partByteLength(job.file.size, job.chunkSizeBytes, part));
      }
    }

    const pendingParts = [];
    for (let partNumber = 1; partNumber <= job.partCount; partNumber += 1) {
      if (!job.confirmedParts.has(partNumber)) pendingParts.push(partNumber);
    }

    let cursor = 0;
    const workerCount = Math.min(PARALLEL_CHUNKS, Math.max(1, pendingParts.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < pendingParts.length) {
        if (job.status === "cancelled") return;
        const partNumber = pendingParts[cursor];
        cursor += 1;
        await uploadChunkWithRetry(job, partNumber);
      }
    });

    await Promise.all(workers);
    if (job.status === "cancelled") return;

    job.status = "completing";
    job.percent = 100;
    job.loadedBytes = job.file.size;
    updateJobUi(job);

    const completed = await api(
      `/api/v1/chats/${job.conversationId}/files/uploads/${job.sessionId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: job.clientMessageId,
          chunkCount: job.partCount,
          sizeBytes: job.file.size,
          text: job.caption
        })
      }
    );

    activeUploads.delete(job.id);
    renderUploadPanel();
    if (completed.message) acceptExternalMessage(completed.message);
    void refreshChatsAfterExternalMessage();
    logDiagnostic("Файлы", "файл отправлен");
    announce(`Файл ${job.file.name} отправлен.`);
  } catch (error) {
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.errorMessage = error instanceof Error ? error.message : "Ошибка сети";
    updateJobUi(job);
    logDiagnostic("Ошибки", "файл не отправлен");
    announce(`Не удалось загрузить файл ${job.file.name}: ${job.errorMessage}`);
  }
}

async function uploadChunkWithRetry(job, partNumber) {
  const start = (partNumber - 1) * job.chunkSizeBytes;
  const end = Math.min(job.file.size, start + job.chunkSizeBytes);
  const slice = job.file.slice(start, end);
  let lastError = null;

  for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt += 1) {
    if (job.status === "cancelled") return;
    try {
      await putChunkViaXhr(job, partNumber, slice);
      job.confirmedParts.add(partNumber);
      job.partLoadedBytes.set(partNumber, slice.size);
      recalculateProgress(job, true);
      return;
    } catch (error) {
      if (job.status === "cancelled") return;
      lastError = error;
      job.partLoadedBytes.set(partNumber, 0);
      recalculateProgress(job, false);
      if (error?.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw error;
      }
      if (attempt < CHUNK_RETRIES) {
        await delay(attempt * 600);
      }
    }
  }
  throw lastError ?? new Error("Не удалось передать часть файла.");
}

function putChunkViaXhr(job, partNumber, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    job.activeXhrs.add(xhr);
    const url = `/api/v1/chats/${encodeURIComponent(job.conversationId)}/files/uploads/${encodeURIComponent(job.sessionId)}/parts/${partNumber}`;
    xhr.open("PUT", url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (job.status === "cancelled") return;
      const loaded = event.lengthComputable
        ? Math.min(blob.size, event.loaded)
        : Math.min(blob.size, event.loaded || 0);
      job.partLoadedBytes.set(partNumber, loaded);
      recalculateProgress(job, false);
    });

    xhr.addEventListener("load", () => {
      job.activeXhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `Ошибка сервера (${xhr.status})`;
      try {
        const parsed = JSON.parse(xhr.responseText);
        if (parsed?.error?.message) message = parsed.error.message;
        else if (parsed?.message) message = parsed.message;
      } catch {}
      const err = new Error(message);
      err.status = xhr.status;
      reject(err);
    });

    xhr.addEventListener("error", () => {
      job.activeXhrs.delete(xhr);
      reject(new Error("Потеряно соединение при передаче файла."));
    });

    xhr.addEventListener("abort", () => {
      job.activeXhrs.delete(xhr);
      reject(new Error("Загрузка отменена."));
    });

    xhr.send(blob);
  });
}

function recalculateProgress(job, forceRender) {
  const { loadedBytes, percent } = computeUploadProgress(job.partLoadedBytes, job.file.size);
  job.loadedBytes = loadedBytes;
  job.percent = percent;

  const now = Date.now();
  const sampleElapsed = now - job.lastSpeedSampleAt;
  if (sampleElapsed >= 500) {
    const deltaBytes = Math.max(0, loadedBytes - job.lastSpeedSampleBytes);
    const instant = (deltaBytes * 1000) / sampleElapsed;
    job.speedBps = job.speedBps > 0 ? job.speedBps * 0.65 + instant * 0.35 : instant;
    job.lastSpeedSampleAt = now;
    job.lastSpeedSampleBytes = loadedBytes;
  }

  for (const milestone of VOICEOVER_MILESTONES) {
    if (
      percent >= milestone &&
      percent < 100 &&
      !job.announcedMilestones.has(milestone) &&
      now - job.lastAnnouncedAt >= 3000
    ) {
      job.announcedMilestones.add(milestone);
      job.lastAnnouncedAt = now;
      announce(`Загрузка ${job.file.name}: ${milestone}%.`);
      break;
    }
  }

  if (forceRender || now - job.lastProgressRenderAt >= 100) {
    job.lastProgressRenderAt = now;
    updateJobUi(job);
  }
}

function cancelUploadJob(job) {
  job.status = "cancelled";
  for (const xhr of job.activeXhrs) {
    try { xhr.abort(); } catch {}
  }
  job.activeXhrs.clear();
  if (job.sessionId) void abortSession(job.conversationId, job.sessionId);
  activeUploads.delete(job.id);
  renderUploadPanel();
  announce(`Загрузка файла ${job.file.name} отменена.`);
}

function cancelAllUploads() {
  for (const job of [...activeUploads.values()]) {
    job.status = "cancelled";
    for (const xhr of job.activeXhrs) {
      try { xhr.abort(); } catch {}
    }
    job.activeXhrs.clear();
  }
  activeUploads.clear();
  renderUploadPanel();
}

async function abortSession(conversationId, sessionId) {
  try {
    await api(`/api/v1/chats/${conversationId}/files/uploads/${sessionId}`, { method: "DELETE" });
  } catch {
    // Best-effort cleanup; Durable Object alarm removes abandoned uploads anyway.
  }
}

function renderUploadPanel() {
  const panel = elements.fileUploadPanel;
  if (!panel) return;
  panel.replaceChildren();
  if (!activeUploads.size) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  for (const job of activeUploads.values()) {
    const item = document.createElement("div");
    item.className = "file-upload-item";
    item.dataset.uploadId = job.id;

    const top = document.createElement("div");
    top.className = "file-upload-header";
    const name = document.createElement("strong");
    name.className = "file-upload-name";
    name.dataset.userContent = "true";
    name.textContent = job.file.name;

    const percentText = document.createElement("span");
    percentText.className = "file-upload-percent";
    top.append(name, percentText);

    const progress = document.createElement("progress");
    progress.className = "file-upload-progress";
    progress.max = 100;
    progress.value = job.percent;
    progress.setAttribute("aria-label", `${translateText("Загрузка файла")} ${job.file.name}`);

    const details = document.createElement("span");
    details.className = "file-upload-details";

    const actions = document.createElement("div");
    actions.className = "file-upload-actions";

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "file-upload-retry";
    retryButton.textContent = translateText("Повторить");
    retryButton.setAttribute("aria-label", `${translateText("Повторить загрузку")} ${job.file.name}`);
    retryButton.hidden = job.status !== "failed";
    retryButton.addEventListener("click", () => void runUploadJob(job));

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "danger-button file-upload-cancel";
    cancelButton.textContent = translateText("Отменить");
    cancelButton.setAttribute("aria-label", `${translateText("Отменить загрузку")} ${job.file.name}`);
    cancelButton.addEventListener("click", () => cancelUploadJob(job));

    actions.append(retryButton, cancelButton);
    item.append(top, progress, details, actions);
    panel.append(item);

    job.ui = { item, percentText, progress, details, retryButton };
    updateJobUi(job);
  }
}

function updateJobUi(job) {
  if (!job.ui) return;
  const { item, percentText, progress, details, retryButton } = job.ui;
  item.dataset.state = job.status;
  progress.value = job.percent;

  if (job.status === "failed") {
    percentText.textContent = translateText("Ошибка");
    details.textContent = job.errorMessage || translateText("Не удалось загрузить файл.");
    retryButton.hidden = false;
    return;
  }

  retryButton.hidden = true;
  if (job.status === "completing") {
    percentText.textContent = "100%";
    details.textContent = translateText("Сохранение в чате…");
    return;
  }

  percentText.textContent = `${job.percent}%`;
  const parts = [
    `${formatFileSize(job.loadedBytes)} ${translateText("из")} ${formatFileSize(job.file.size)}`
  ];
  const speed = formatTransferSpeed(job.speedBps);
  if (speed) parts.push(speed);
  details.textContent = parts.join(" · ");
}

function partByteLength(totalSize, chunkSize, partNumber) {
  const start = (partNumber - 1) * chunkSize;
  return Math.max(0, Math.min(chunkSize, totalSize - start));
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `fu_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
