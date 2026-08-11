export const AUDIO_PROFILE_IDS = ["normal", "clean", "studio", "music"];

export const AUDIO_PROFILES = Object.freeze({
  normal: Object.freeze({
    id: "normal",
    label: "Обычный",
    description: "Для разговоров: эхоподавление, шумоподавление и автоматическая громкость включены.",
    contentHint: "speech",
    maxBitrate: 64_000,
    constraints: Object.freeze({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: Object.freeze({ ideal: 1 })
    })
  }),
  clean: Object.freeze({
    id: "clean",
    label: "Чистый голос",
    description: "Шум и эхо подавляются, но автоматическая громкость выключена, чтобы меньше менять динамику голоса.",
    contentHint: "speech",
    maxBitrate: 80_000,
    constraints: Object.freeze({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: Object.freeze({ ideal: 1 })
    })
  }),
  studio: Object.freeze({
    id: "studio",
    label: "Студийный",
    description: "Original Sound: просим браузер отключить эхо, шумоподавление и автогромкость и сохранить 48 кГц без речевой обработки.",
    contentHint: "music",
    maxBitrate: 128_000,
    constraints: Object.freeze({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: Object.freeze({ ideal: 48_000 }),
      channelCount: Object.freeze({ ideal: 1 })
    })
  }),
  music: Object.freeze({
    id: "music",
    label: "Музыка",
    description: "Максимально сырой музыкальный режим: обработка речи выключена, 48 кГц, стерео если микрофон и браузер его реально дают, повышенный WebRTC-битрейт.",
    contentHint: "music",
    maxBitrate: 192_000,
    constraints: Object.freeze({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: Object.freeze({ ideal: 48_000 }),
      channelCount: Object.freeze({ ideal: 2 })
    })
  })
});

export function normalizeAudioProfile(value) {
  return AUDIO_PROFILE_IDS.includes(value) ? value : "normal";
}

export function getAudioProfile(value) {
  return AUDIO_PROFILES[normalizeAudioProfile(value)];
}

export function buildAudioConstraints(profileId, supportedConstraints = null) {
  const profile = getAudioProfile(profileId);
  const result = {};

  for (const [key, value] of Object.entries(profile.constraints)) {
    if (supportedConstraints && supportedConstraints[key] !== true) continue;
    result[key] = cloneConstraint(value);
  }

  return result;
}

export function summarizeTrackSettings(profileId, settings = {}) {
  const profile = getAudioProfile(profileId);
  const parts = [];
  const mismatches = [];
  const unknown = [];

  for (const [key, label] of [
    ["echoCancellation", "эхоподавление"],
    ["noiseSuppression", "шумоподавление"],
    ["autoGainControl", "автогромкость"]
  ]) {
    const requested = profile.constraints[key];
    const actual = settings[key];
    if (typeof actual === "boolean") {
      parts.push(`${label} ${actual ? "включено" : "выключено"}`);
      if (typeof requested === "boolean" && actual !== requested) mismatches.push(label);
    } else {
      parts.push(`${label}: браузер не сообщает`);
      unknown.push(label);
    }
  }

  if (Number.isFinite(settings.sampleRate)) {
    parts.push(`${Math.round(settings.sampleRate).toLocaleString("ru-RU")} Гц`);
  } else {
    parts.push("частота: браузер не сообщает");
  }

  if (Number.isFinite(settings.channelCount)) {
    const channels = Number(settings.channelCount);
    parts.push(channels === 2 ? "стерео, 2 канала" : `${channels} канал`);
  } else {
    parts.push("каналы: браузер не сообщает");
  }

  return {
    text: parts.join("; "),
    mismatches,
    unknown,
    confirmed: mismatches.length === 0 && unknown.length === 0
  };
}

function cloneConstraint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value };
}
