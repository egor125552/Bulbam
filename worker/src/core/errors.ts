export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ApiError(400, code, message, details);
}

export function unauthorized(code = "unauthorized", message = "Требуется авторизация."): never {
  throw new ApiError(401, code, message);
}

export function forbidden(code = "forbidden", message = "Недостаточно прав."): never {
  throw new ApiError(403, code, message);
}

export function notFound(code = "not_found", message = "Не найдено."): never {
  throw new ApiError(404, code, message);
}

export function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}
