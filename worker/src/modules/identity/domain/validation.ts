import { badRequest } from "../../../core/errors";

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    badRequest("invalid_input", `Поле ${key} обязательно.`);
  }
  return value;
}

export function normalizeUsername(raw: string): string {
  const username = raw.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    badRequest(
      "invalid_username",
      "Username должен содержать 3–32 латинских символа, цифры или подчёркивание."
    );
  }
  return username;
}

export function normalizeDisplayNameForSearch(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

export function validateDisplayName(raw: string): string {
  const value = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (value.length < 1 || value.length > 64) {
    badRequest("invalid_display_name", "Имя должно содержать от 1 до 64 символов.");
  }
  return value;
}

export function validateUserSearchQuery(raw: string): string {
  const value = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (value.length < 2 || value.length > 64) {
    badRequest("invalid_search_query", "Для поиска введи от 2 до 64 символов.");
  }
  return value;
}

export function validatePassword(raw: string): string {
  if (raw.length < 10 || raw.length > 128) {
    badRequest("invalid_password", "Пароль должен содержать от 10 до 128 символов.");
  }
  return raw;
}

export function validateDeviceName(raw: string | undefined): string {
  const value = (raw ?? "Web browser").trim().replace(/\s+/g, " ");
  if (!value || value.length > 80) {
    badRequest("invalid_device_name", "Название устройства должно содержать от 1 до 80 символов.");
  }
  return value;
}

export function validateInviteCode(raw: string): string {
  const value = raw.trim();
  if (value.length < 16 || value.length > 160) {
    badRequest("invalid_invite", "Некорректный код приглашения.");
  }
  return value;
}

export function registrationInput(body: Record<string, unknown>) {
  return {
    username: normalizeUsername(requiredString(body, "username")),
    displayName: validateDisplayName(requiredString(body, "displayName")),
    password: validatePassword(requiredString(body, "password")),
    inviteCode: validateInviteCode(requiredString(body, "inviteCode")),
    deviceName: validateDeviceName(typeof body.deviceName === "string" ? body.deviceName : undefined)
  };
}

export function loginInput(body: Record<string, unknown>) {
  return {
    username: normalizeUsername(requiredString(body, "username")),
    password: validatePassword(requiredString(body, "password")),
    deviceName: validateDeviceName(typeof body.deviceName === "string" ? body.deviceName : undefined)
  };
}
