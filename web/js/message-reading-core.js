export const MESSAGE_READING_STORAGE_KEY = "bulbam.accessibility.messageReadingMode";
export const DEFAULT_MESSAGE_READING_MODE = "parts";
export const MESSAGE_READING_MODES = ["parts", "single", "telegram", "table"];

export const MESSAGE_READING_SAMPLE_ITEMS = [
  {
    messageId: "sample-incoming-text",
    senderUserId: "sample-pasha",
    authorName: "Паша",
    mine: false,
    kind: "text",
    text: "Короче, всё заработало, можешь проверять!",
    createdAt: new Date(2026, 10, 24, 23, 31).getTime(),
    deliveredAt: new Date(2026, 10, 24, 23, 31).getTime(),
    readAt: new Date(2026, 10, 24, 23, 31).getTime()
  },
  {
    messageId: "sample-outgoing-text",
    senderUserId: "sample-me",
    authorName: "Вы",
    mine: true,
    kind: "text",
    text: "Отлично, сейчас посмотрю и напишу.",
    createdAt: new Date(2026, 10, 24, 23, 32).getTime(),
    deliveredAt: new Date(2026, 10, 24, 23, 32).getTime(),
    readAt: new Date(2026, 10, 24, 23, 32).getTime()
  },
  {
    messageId: "sample-outgoing-voice",
    senderUserId: "sample-me",
    authorName: "Вы",
    mine: true,
    kind: "voice",
    text: "",
    createdAt: new Date(2026, 10, 25, 3, 3).getTime(),
    deliveredAt: new Date(2026, 10, 25, 3, 3).getTime(),
    readAt: new Date(2026, 10, 25, 3, 3).getTime(),
    voice: {
      durationMs: 69000,
      progress: {
        completedAt: new Date(2026, 10, 25, 3, 5).getTime(),
        listenedMs: 69000,
        active: false
      }
    }
  }
];

export function normalizeMessageReadingMode(value) {
  return MESSAGE_READING_MODES.includes(value) ? value : DEFAULT_MESSAGE_READING_MODE;
}

export function pluralForm(count, one, few, many) {
  const abs = Math.abs(Math.trunc(count));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function formatDurationSpoken(durationMs, translate = (value) => value) {
  const totalSeconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours} ${translate(pluralForm(hours, "час", "часа", "часов"))}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} ${translate(pluralForm(minutes, "минута", "минуты", "минут"))}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${translate(pluralForm(seconds, "секунда", "секунды", "секунд"))}`);
  }
  return parts.join(" ");
}

export function formatShortClock(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatFullTimestampSpoken(timestamp, locale = "ru", translate = (value) => value) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const clock = formatShortClock(timestamp);
  const intlLocale = locale === "be" ? "be-BY" : "ru-RU";
  const dayMonth = new Intl.DateTimeFormat(intlLocale, { day: "numeric", month: "long" }).format(date);
  return `${dayMonth} ${translate("в")} ${clock}`;
}

export function formatCompactFileSize(bytes, translate = (value) => value) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} ${translate("Б")}`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} ${translate("КБ")}`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} ${translate("МБ")}`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2).replace(/\.00$/, "")} ${translate("ГБ")}`;
}

export function deliveryStatusSummary(message, {
  mine = false,
  isGroup = false,
  verbose = false,
  translate = (value) => value
} = {}) {
  const parts = [];

  if (message.localState === "pending") {
    parts.push(translate("отправляется"));
  } else if (message.localState === "failed") {
    parts.push(translate("не отправлено"));
  } else if (mine && !isGroup) {
    if (message.readAt) {
      parts.push(translate(verbose ? "прочитано получателем" : "прочитано"));
    } else if (message.deliveredAt) {
      parts.push(translate(verbose ? "доставлено получателю" : "доставлено"));
    } else {
      parts.push(translate("отправлено"));
    }
  }

  if (mine && message.kind === "voice" && message.voice && !message.localState) {
    const progress = message.voice.progress;
    if (progress?.active) {
      parts.push(translate("сейчас слушает"));
    } else if (progress?.completedAt) {
      parts.push(translate(verbose ? "прослушано получателем" : "прослушано"));
    } else if (progress?.listenedMs > 0) {
      const heard = formatDurationSpoken(progress.listenedMs, translate);
      parts.push(`${translate("прослушано")} ${heard}`);
    } else if (verbose) {
      parts.push(translate("ещё не прослушано"));
    }
  }

  return parts.join(", ");
}

function fileMediaLabel(mediaKind, mine, telegramStyle, translate) {
  if (telegramStyle && mine) {
    if (mediaKind === "image") return translate("Ваше фото");
    if (mediaKind === "video") return translate("Ваше видео");
    if (mediaKind === "audio") return translate("Ваш аудиофайл");
    return translate("Ваш файл");
  }
  if (mediaKind === "image") return translate("Фото");
  if (mediaKind === "video") return translate("Видео");
  if (mediaKind === "audio") return translate("Аудиофайл");
  return translate("Файл");
}

function capitalizeSentence(value) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatReplyPrefix(message, translate) {
  if (!message?.replyTo) return "";
  if (message.replyTo.deleted) {
    return `${translate("В ответ на удалённое сообщение")}.`;
  }
  const author = message.replyTo.senderDisplayName || translate("Участник");
  const excerpt = (message.replyTo.text || "").trim();
  return excerpt
    ? `${translate("В ответ на сообщение от")} ${author}: ${excerpt}.`
    : `${translate("В ответ на сообщение от")} ${author}.`;
}

function formatForwardPrefix(message, translate) {
  const fromName = message?.forwardedFrom?.fromDisplayName || message?.forwardedFrom?.displayName;
  if (!fromName) return "";
  return `${translate("Переслано от")} ${fromName}.`;
}

function formatReactionsSummary(message, translate) {
  if (!Array.isArray(message?.reactions) || !message.reactions.length) return "";
  const list = message.reactions.map((entry) => `${entry.emoji} ${entry.count}`).join(", ");
  return `${translate("Реакции")}: ${list}.`;
}

export function buildMessageReadingText(message, {
  mode = DEFAULT_MESSAGE_READING_MODE,
  mine = false,
  authorName = "",
  isGroup = false,
  locale = "ru",
  translate = (value) => value
} = {}) {
  const normalizedMode = normalizeMessageReadingMode(mode);
  const resolvedAuthor = mine ? "Вы" : (authorName || translate("Участник"));
  const shortClock = formatShortClock(message.createdAt);
  const fullTimestamp = formatFullTimestampSpoken(message.createdAt, locale, translate);
  const forwardPrefix = formatForwardPrefix(message, translate);
  const replyPrefix = formatReplyPrefix(message, translate);
  const reactionsSuffix = formatReactionsSummary(message, translate);
  const favoriteSuffix = message?.isFavorite ? `${translate("В избранном")}.` : "";

  if (normalizedMode === "telegram") {
    const status = deliveryStatusSummary(message, { mine, isGroup, verbose: true, translate });
    const chunks = [];
    if (forwardPrefix) chunks.push(forwardPrefix);
    if (replyPrefix) chunks.push(replyPrefix);

    if (message.kind === "voice" && message.voice) {
      const duration = formatDurationSpoken(message.voice.durationMs, translate);
      if (mine) {
        chunks.push(translate("Ваше голосовое сообщение."));
      } else {
        chunks.push(`${resolvedAuthor}. ${translate("Голосовое сообщение.")}`);
      }
      chunks.push(`${translate("Длительность")}: ${duration}.`);
    } else if (message.kind === "file" && message.file) {
      const label = fileMediaLabel(message.file.mediaKind, mine, true, translate);
      const size = formatCompactFileSize(message.file.sizeBytes, translate);
      const filePart = `${label}: ${message.file.fileName}, ${size}.`;
      chunks.push(mine ? filePart : `${resolvedAuthor}. ${filePart}`);
      if (message.text) chunks.push(message.text);
    } else {
      const prefix = mine ? translate("Ваше сообщение.") : `${resolvedAuthor}.`;
      chunks.push(`${prefix} ${message.text || ""}`.trim());
    }

    if (reactionsSuffix) chunks.push(reactionsSuffix);
    if (favoriteSuffix) chunks.push(favoriteSuffix);
    if (fullTimestamp) chunks.push(`${fullTimestamp}.`);
    if (status) chunks.push(`${capitalizeSentence(status)}.`);
    return chunks.join(" ");
  }

  const status = deliveryStatusSummary(message, { mine, isGroup, verbose: false, translate });
  const tail = [shortClock, status].filter(Boolean).join(", ");
  const extras = [reactionsSuffix, favoriteSuffix].filter(Boolean).join(" ");
  const contextPrefix = [forwardPrefix, replyPrefix].filter(Boolean).join(" ");

  if (message.kind === "voice" && message.voice) {
    const duration = formatDurationSpoken(message.voice.durationMs, translate);
    const head = mine
      ? translate("Ваше голосовое сообщение")
      : `${resolvedAuthor}, ${translate("голосовое сообщение")}`;
    return [contextPrefix, [head, duration, tail].filter(Boolean).join(", "), extras].filter(Boolean).join(" ");
  }

  if (message.kind === "file" && message.file) {
    const label = fileMediaLabel(message.file.mediaKind, mine, false, translate).toLowerCase();
    const size = formatCompactFileSize(message.file.sizeBytes, translate);
    const caption = message.text ? `. ${message.text}` : "";
    const head = `${resolvedAuthor}: ${label} ${message.file.fileName}, ${size}${caption}`;
    return [contextPrefix, tail ? `${head}. ${tail}` : head, extras].filter(Boolean).join(" ");
  }

  const textBody = `${resolvedAuthor}: ${message.text || ""}`.trim();
  const base = tail ? `${textBody}. ${tail}` : textBody;
  return [contextPrefix, base, extras].filter(Boolean).join(" ");
}

export function readingModeDescription(mode) {
  switch (normalizeMessageReadingMode(mode)) {
    case "single":
      return "Каждое сообщение читается одним смахиванием: автор, текст или длительность голосового, время и статус.";
    case "telegram":
      return "Подробное чтение в стиле Telegram: тип сообщения, автор, длительность словами, дата, время, прочитано и прослушано. Двойное касание по голосовому сразу запускает его.";
    case "table":
      return "Настоящая таблица с колонками «Отправитель», «Сообщение» и «Время и статус». На Mac удобно листать сообщения стрелками по колонке «Сообщение».";
    default:
      return "Классический режим: автор, текст или плеер, время и статус читаются отдельными элементами подряд.";
  }
}

export function readingModeAnnouncement(mode) {
  switch (normalizeMessageReadingMode(mode)) {
    case "single":
      return "Включён режим чтения одним сообщением.";
    case "telegram":
      return "Включён подробный режим чтения как в Telegram.";
    case "table":
      return "Включён табличный режим чтения сообщений.";
    default:
      return "Включён классический режим чтения сообщений по частям.";
  }
}
