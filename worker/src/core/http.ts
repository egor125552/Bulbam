import { ApiError } from "./errors";

const MAX_JSON_BODY_BYTES = 16 * 1024;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function methodNotAllowed(allowed: string[]): Response {
  return json(
    { ok: false, error: { code: "method_not_allowed", message: "Метод не поддерживается." } },
    { status: 405, headers: { allow: allowed.join(", ") } }
  );
}

export function handleError(error: unknown, exposeDetails = false): Response {
  if (error instanceof ApiError) {
    return json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        }
      },
      { status: error.status }
    );
  }

  console.error("[Bulbam] unhandled error", error);
  const diagnostic = error instanceof Error ? error.message : String(error);
  return json(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: "Внутренняя ошибка сервера.",
        ...(exposeDetails ? { diagnostic } : {})
      }
    },
    { status: 500 }
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "Запрос слишком большой.");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "Запрос слишком большой.");
  }

  if (!text.trim()) {
    throw new ApiError(400, "empty_body", "Нужны данные запроса.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Некорректный JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_body", "Ожидается JSON-объект.");
  }

  return parsed as Record<string, unknown>;
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}
