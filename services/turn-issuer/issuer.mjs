import { createHmac, createPublicKey, verify } from "node:crypto";

const DEFAULT_URLS = [
  "turn:169.58.224.216:3478?transport=udp",
  "turn:169.58.224.216:3478?transport=tcp"
];

export function readCoturnSecret(configuration) {
  const match = String(configuration).match(/^\s*static-auth-secret\s*=\s*(\S+)\s*$/m);
  if (!match || match[1].length < 16) throw new Error("Coturn shared secret is missing");
  return match[1];
}

export function vapidPublicKey(encoded) {
  const bytes = Buffer.from(String(encoded).trim(), "base64url");
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid VAPID public key");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: bytes.subarray(1, 33).toString("base64url"),
      y: bytes.subarray(33, 65).toString("base64url")
    },
    format: "jwk"
  });
}

export function signedMessage(timestamp, identity, nonce) {
  return `bulbam-turn-v1\n${timestamp}\n${identity}\n${nonce}`;
}

export function validateSignedRequest(headers, key, now = Date.now()) {
  const timestamp = headers["x-bulbam-timestamp"];
  const identity = headers["x-bulbam-user"];
  const nonce = headers["x-bulbam-nonce"];
  const signature = headers["x-bulbam-signature"];
  if (typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) ||
      Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 30 ||
      typeof identity !== "string" || !/^[0-9a-f-]{36}$/i.test(identity) ||
      typeof nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(nonce) ||
      typeof signature !== "string" || !/^[A-Za-z0-9_-]{70,120}$/.test(signature)) {
    return null;
  }
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64) return null;
  const valid = verify("sha256", Buffer.from(signedMessage(timestamp, identity, nonce)), {
    key,
    dsaEncoding: "ieee-p1363"
  }, signatureBytes);
  return valid ? { identity, nonce, timestamp: Number(timestamp) } : null;
}

export function issueTurnCredentials(secret, identity, now = Date.now(), urls = DEFAULT_URLS) {
  const username = `${Math.floor(now / 1000) + 600}:${identity}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { iceServers: [{ urls, username, credential }] };
}

// Stateless signature validation plus a small in-memory anti-replay / per-account rate limit.
export function createRequestGate() {
  const seen = new Map();
  const requests = new Map();
  return function accept(identity, nonce, now = Date.now()) {
    for (const [key, until] of seen) if (until <= now) seen.delete(key);
    const replayKey = `${identity}:${nonce}`;
    if (seen.has(replayKey)) return false;
    const recent = (requests.get(identity) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 30) return false;
    seen.set(replayKey, now + 60_000);
    recent.push(now);
    requests.set(identity, recent);
    if (requests.size > 10_000) requests.clear();
    return true;
  };
}
