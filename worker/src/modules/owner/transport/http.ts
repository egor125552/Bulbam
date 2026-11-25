import { ApiError } from "../../../core/errors";
import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { IdentityService } from "../../identity/application/identity-service";
import { validateDeviceName } from "../../identity/domain/validation";
import { sessionToken, withSessionCookie } from "../../identity/transport/http";
import type { OwnerControlService } from "../application/owner-control-service";

export async function handleOwnerHttp(
  request: Request,
  url: URL,
  identity: IdentityService,
  ownerControl: OwnerControlService
): Promise<Response | null> {
  if (url.pathname === "/api/v1/auth/owner-login-token") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const body = await readJsonObject(request);
    const deviceName = validateDeviceName(typeof body.deviceName === "string" ? body.deviceName : undefined);
    const result = await ownerControl.redeemOneTimeLoginToken(String(body.token ?? ""), deviceName);
    return withSessionCookie(
      request,
      json({ ok: true, account: result.account, session: result.session }),
      result.token,
      result.session.expiresAt
    );
  }

  if (!url.pathname.startsWith("/api/v1/owner/")) return null;

  if (url.pathname === "/api/v1/owner/users") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const auth = await identity.authenticate(sessionToken(request));
    const users = await ownerControl.listUsers(auth);
    return json({ ok: true, users });
  }

  const restoreMatch = url.pathname.match(/^\/api\/v1\/owner\/users\/([0-9a-f-]{36})\/restore-session$/i);
  if (restoreMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const auth = await identity.authenticate(sessionToken(request));
    const result = await ownerControl.restoreUserSession(auth, restoreMatch[1]);
    return json({ ok: true, ...result });
  }

  const loginLinkMatch = url.pathname.match(/^\/api\/v1\/owner\/users\/([0-9a-f-]{36})\/login-link$/i);
  if (loginLinkMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const auth = await identity.authenticate(sessionToken(request));
    const result = await ownerControl.createOneTimeLoginLink(auth, loginLinkMatch[1], url.origin);
    return json({ ok: true, ...result });
  }

  const revokeMatch = url.pathname.match(/^\/api\/v1\/owner\/users\/([0-9a-f-]{36})\/revoke-sessions$/i);
  if (revokeMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const auth = await identity.authenticate(sessionToken(request));
    const result = await ownerControl.revokeUserSessions(auth, revokeMatch[1]);
    return json({ ok: true, ...result });
  }

  const userMatch = url.pathname.match(/^\/api\/v1\/owner\/users\/([0-9a-f-]{36})$/i);
  if (userMatch) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const auth = await identity.authenticate(sessionToken(request));
    const body = await readJsonObject(request);
    if (typeof body.confirmed !== "boolean") {
      throw new ApiError(400, "confirmation_required", "Подтвердите удаление пользователя флажком.");
    }
    const result = await ownerControl.deleteUserCompletely(auth, userMatch[1], {
      confirmed: body.confirmed,
      reason: typeof body.reason === "string" ? body.reason : ""
    });
    return json({ ok: true, ...result });
  }

  return null;
}
