import { ApiError } from "../../../core/errors";
import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { IdentityService } from "../application/identity-service";
import { loginInput, registrationInput } from "../domain/validation";

const SESSION_COOKIE = "bulbam_session";

export async function handleIdentityHttp(
  request: Request,
  url: URL,
  service: IdentityService
): Promise<Response | null> {
  if (url.pathname === "/api/v1/auth/register") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const input = registrationInput(await readJsonObject(request));
    const result = await service.register(input);
    return withSessionCookie(
      json({ ok: true, account: result.account, session: result.session }, { status: 201 }),
      result.token,
      result.session.expiresAt
    );
  }

  if (url.pathname === "/api/v1/auth/login") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const input = loginInput(await readJsonObject(request));
    const result = await service.login(input);
    return withSessionCookie(
      json({ ok: true, account: result.account, session: result.session }),
      result.token,
      result.session.expiresAt
    );
  }

  if (url.pathname === "/api/v1/auth/me") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const authenticated = await service.authenticate(sessionToken(request));
    return json({ ok: true, account: authenticated.account, session: authenticated.session });
  }

  if (url.pathname === "/api/v1/auth/logout") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const authenticated = await service.authenticate(sessionToken(request));
    await service.logout(authenticated);
    return clearSessionCookie(json({ ok: true }));
  }

  if (url.pathname === "/api/v1/sessions") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const authenticated = await service.authenticate(sessionToken(request));
    const sessions = await service.listSessions(authenticated);
    return json({
      ok: true,
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: session.sessionId === authenticated.session.sessionId
      }))
    });
  }

  const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([0-9a-f-]{36})$/i);
  if (sessionMatch) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const authenticated = await service.authenticate(sessionToken(request));
    await service.revokeSession(authenticated, sessionMatch[1]);
    const response = json({ ok: true });
    return sessionMatch[1] === authenticated.session.sessionId
      ? clearSessionCookie(response)
      : response;
  }

  if (url.pathname === "/api/v1/invites") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const authenticated = await service.authenticate(sessionToken(request));
    const body = await readJsonObject(request);
    const expiresInHours =
      typeof body.expiresInHours === "number" ? body.expiresInHours : undefined;
    const result = await service.createInvite(authenticated, expiresInHours);
    return json(
      {
        ok: true,
        invite: result.invite,
        code: result.code,
        note: "Код показывается только сейчас. Сервер хранит только его хэш."
      },
      { status: 201 }
    );
  }

  return null;
}

function sessionToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }

  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function withSessionCookie(response: Response, token: string, expiresAt: number): Response {
  const headers = new Headers(response.headers);
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clearSessionCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function identityNotFound(): never {
  throw new ApiError(404, "not_found", "API-маршрут не найден.");
}
