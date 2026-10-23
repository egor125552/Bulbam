import { describe, expect, test, vi, afterEach } from "vitest";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  createRequestGate, issueTurnCredentials, readCoturnSecret, signedMessage,
  validateSignedRequest, vapidPublicKey
} from "../services/turn-issuer/issuer.mjs";
import { makeIceServers } from "../worker/src/modules/calls/infrastructure/webrtc-config.ts";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = publicKey.export({ format: "jwk" });
const vapidPub = Buffer.concat([
  Buffer.from([4]), Buffer.from(publicJwk.x, "base64url"), Buffer.from(publicJwk.y, "base64url")
]).toString("base64url");
const vapidPriv = privateJwk.d;
const userId = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.unstubAllGlobals());

describe("Private VPS TURN issuer", () => {
  test("refuses unsigned or stale requests, and rejects replay", () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const nonce = "22222222-2222-4222-8222-222222222222";
    const signature = sign("sha256", Buffer.from(signedMessage(timestamp, userId, nonce)), {
      key: privateKey, dsaEncoding: "ieee-p1363"
    }).toString("base64url");
    const headers = {
      "x-bulbam-timestamp": timestamp,
      "x-bulbam-user": userId,
      "x-bulbam-nonce": nonce,
      "x-bulbam-signature": signature
    };
    const key = vapidPublicKey(vapidPub);
    expect(validateSignedRequest(headers, key, now)?.identity).toBe(userId);
    expect(validateSignedRequest(headers, key, now + 120_000)).toBeNull();
    expect(validateSignedRequest({ ...headers, "x-bulbam-user": "someone" }, key, now)).toBeNull();
    expect(validateSignedRequest({ ...headers, "x-bulbam-signature": "invalid" }, key, now)).toBeNull();
    const gate = createRequestGate();
    expect(gate(userId, nonce, now)).toBe(true);
    expect(gate(userId, nonce, now)).toBe(false);
  });

  test("coturn credentials are short-lived HMAC credentials", () => {
    expect(readCoturnSecret("use-auth-secret\nstatic-auth-secret=longrandomsecretvalue0123456789\n"))
      .toBe("longrandomsecretvalue0123456789");
    const result = issueTurnCredentials("longrandomsecretvalue0123456789", userId, 1_000_000);
    const item = result.iceServers[0];
    expect(item.username).toBe(`1600:${userId}`);
    expect(item.credential).toBe(createHmac("sha1", "longrandomsecretvalue0123456789")
      .update(item.username).digest("base64"));
  });

  test("Worker obtains valid temporary TURN credentials through a signed request", async () => {
    const serverKey = vapidPublicKey(vapidPub);
    const secret = "longrandomsecretvalue0123456789";
    let verified = false;
    vi.stubGlobal("fetch", async (_url, init) => {
      expect(init.method).toBe("POST");
      expect(init.headers["x-bulbam-signature"]).not.toBe(vapidPriv);
      const proof = validateSignedRequest(init.headers, serverKey);
      expect(proof?.identity).toBe(userId);
      verified = true;
      return new Response(JSON.stringify({ ok: true, ...issueTurnCredentials(secret, userId) }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    });
    const servers = await makeIceServers({
      WEBRTC_RELAY_ISSUER_URL: "https://169-58-224-216.sslip.io/bulbam-relay-issuer/credentials",
      VAPID_PUBLIC_KEY: vapidPub, VAPID_PRIVATE_KEY: vapidPriv
    }, userId);
    expect(verified).toBe(true);
    expect(servers.some((server) => String(server.urls).includes("turn:"))).toBe(true);
    expect(servers.some((server) => String(server.urls).includes("stun:"))).toBe(true);
    expect(JSON.stringify(servers)).not.toContain(vapidPriv);
    expect(JSON.stringify(servers)).not.toContain(secret);
  });
});
