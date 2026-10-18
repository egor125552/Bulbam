import { ApiError } from "../../../core/errors";
import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { IdentityService } from "../application/identity-service";
import type { AdminRecoveryService } from "../application/admin-recovery-service";
import type { PasskeyService } from "../application/passkey-service";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import { loginInput, registrationInput, normalizeUsername, validateDeviceName, validatePassword } from "../domain/validation";

const SESSION_COOKIE = "bulbam_session";

export async function handleIdentityHttp(
  request: Request,
  url: URL,
  service: IdentityService,
  passkeys?: PasskeyService | null,
  recovery?: AdminRecoveryService | null
): Promise<Response | null> {
  if (recovery && url.pathname === "/api/v1/auth/admin-recovery/request") {
    if(request.method!=="POST")return methodNotAllowed(["POST"]);
    const body=await readJsonObject(request);
    return json(await recovery.request(normalizeUsername(String(body.username??"")),
      validateDeviceName(typeof body.deviceName==="string"?body.deviceName:undefined),
      request.headers.get("cf-connecting-ip") ?? "unknown"));
  }
  if (recovery && url.pathname === "/api/v1/auth/admin-recovery/status") {
    if(request.method!=="POST")return methodNotAllowed(["POST"]);
    const body=await readJsonObject(request);
    return json(await recovery.status(String(body.requestId??""),String(body.secret??"")));
  }
  if (recovery && url.pathname === "/api/v1/auth/admin-recovery/complete") {
    if(request.method!=="POST")return methodNotAllowed(["POST"]);
    const body=await readJsonObject(request);
    const result=await recovery.complete(String(body.requestId??""),String(body.secret??""),
      validatePassword(String(body.newPassword??"")),
      validateDeviceName(typeof body.deviceName==="string"?body.deviceName:undefined));
    return withSessionCookie(json({ok:true,account:result.account,session:result.session,
      recoveryCodes:result.recoveryCodes}),result.token,result.session.expiresAt);
  }
  if (recovery && url.pathname === "/api/v1/admin/recovery-requests") {
    if(request.method!=="GET")return methodNotAllowed(["GET"]);
    const auth=await service.authenticate(sessionToken(request));
    return json({ok:true,requests:await recovery.list(auth)});
  }
  const decision = recovery && url.pathname.match(/^\/api\/v1\/admin\/recovery-requests\/([0-9a-f-]{36})\/decision$/i);
  if (recovery && decision) {
    if(request.method!=="POST")return methodNotAllowed(["POST"]);
    const auth=await service.authenticate(sessionToken(request));
    const body=await readJsonObject(request);
    if(typeof body.approve!=="boolean")throw new ApiError(400,"invalid_input","Выберите решение.");
    return json(await recovery.decide(auth,decision[1],body.approve,body.verifiedIdentity===true));
  }

  if (passkeys && url.pathname === "/api/v1/passkeys") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const auth = await service.authenticate(sessionToken(request));
    return json({ok:true,passkeys:await passkeys.list(auth.account.userId)});
  }
  if (passkeys && url.pathname === "/api/v1/passkeys/registration/options") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const auth = await service.authenticate(sessionToken(request));
    return json({ok:true,...await passkeys.registrationOptions(auth,url.origin)});
  }
  if (passkeys && url.pathname === "/api/v1/passkeys/registration/verify") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const auth = await service.authenticate(sessionToken(request));
    const body=await readJsonObject(request);
    if(typeof body.challengeId !== "string" || typeof body.response !== "object" || body.response === null)
      throw new ApiError(400,"invalid_input","Некорректные данные ключа доступа.");
    return json(await passkeys.registrationFinish(auth,url.origin,{
      challengeId:body.challengeId,response:body.response as RegistrationResponseJSON,
      name:typeof body.name==="string"?body.name:undefined
    }));
  }
  if (passkeys && url.pathname === "/api/v1/passkeys/authentication/options") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    // The real client address is supplied by Cloudflare, not a spoofable header.
    const requester=request.headers.get("cf-connecting-ip") ?? "unknown";
    return json({ok:true,...await passkeys.authenticationOptions(url.origin,requester)});
  }
  if (passkeys && url.pathname === "/api/v1/passkeys/authentication/verify") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body=await readJsonObject(request);
    if(typeof body.challengeId !== "string" || typeof body.response !== "object" || body.response === null)
      throw new ApiError(400,"invalid_input","Некорректные данные ключа доступа.");
    const deviceName=validateDeviceName(typeof body.deviceName==="string"?body.deviceName:undefined);
    const result=await passkeys.authenticationFinish(url.origin,{
      challengeId:body.challengeId,response:body.response as AuthenticationResponseJSON,deviceName
    });
    return withSessionCookie(json({ok:true,account:result.account,session:result.session}),
      result.token,result.session.expiresAt);
  }
  const passkeyDelete = passkeys && url.pathname.match(/^\/api\/v1\/passkeys\/([A-Za-z0-9_-]{8,1024})$/);
  if (passkeys && passkeyDelete) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const auth=await service.authenticate(sessionToken(request));
    const removed=await passkeys.remove(auth.account.userId,passkeyDelete[1]);
    if(!removed)throw new ApiError(404,"passkey_not_found","Ключ доступа не найден.");
    return json({ok:true});
  }

  if (url.pathname === "/api/v1/auth/register") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const input = registrationInput(await readJsonObject(request));
    const result = await service.register(input);
    return withSessionCookie(
      json({ ok: true, account: result.account, session: result.session, recoveryCodes: result.recoveryCodes }, { status: 201 }),
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

  if (url.pathname === "/api/v1/auth/reset-with-recovery-code") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body = await readJsonObject(request);
    const username = normalizeUsername(String(body.username ?? ""));
    const rawCode = body.code;
    if (typeof rawCode !== "string" || !/^BRC-[0-9a-fA-F]{6}(?:-[0-9a-fA-F]{6}){3}$/.test(rawCode)) {
      throw new ApiError(400, "invalid_recovery_code", "Неверное имя пользователя или код восстановления.");
    }
    const newPassword = validatePassword(String(body.newPassword ?? ""));
    const deviceName = validateDeviceName(typeof body.deviceName === "string" ? body.deviceName : undefined);
    const result = await service.resetPasswordWithRecoveryCode({
      username, code: rawCode, newPassword, deviceName
    });
    return withSessionCookie(
      json({ ok: true, account: result.account, session: result.session, recoveryCodes: result.recoveryCodes }),
      result.token, result.session.expiresAt
    );
  }

  if (url.pathname === "/api/v1/auth/recovery-codes") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const authenticated = await service.authenticate(sessionToken(request));
    const recoveryCodes = await service.issueRecoveryCodes(authenticated.account.userId);
    return json({ ok: true, recoveryCodes });
  }

  if (url.pathname === "/api/v1/auth/change-password") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const authenticated = await service.authenticate(sessionToken(request));
    const body = await readJsonObject(request);
    const password = validatePassword(String(body.newPassword ?? ""));
    await service.changePasswordFromSession(authenticated, password);
    return json({ ok: true, note: "Другие устройства отключены. Создайте новые резервные коды." });
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

  if (url.pathname === "/api/v1/users/search") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const authenticated = await service.authenticate(sessionToken(request));
    const users = await service.searchUsers(authenticated, url.searchParams.get("q") ?? "");
    return json({ ok: true, users });
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

export function sessionToken(request: Request): string | null {
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
