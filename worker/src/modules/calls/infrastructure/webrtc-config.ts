import type { Env } from "../../../platform/cloudflare";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN_URLS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302"
];

export async function makeIceServers(env: Env, identity: string): Promise<IceServer[]> {
  const cloudflare = await cloudflareTurnIceServers(env);
  if (cloudflare.length) return mergeStunFallback(env, cloudflare);

  const remote = await signedRelayIceServers(env, identity);
  if (remote.length) return mergeStunFallback(env, remote);

  const shared = await sharedSecretTurn(env, identity);
  const configured = defaultIceServers(env, shared);
  return configured.length ? configured : DEFAULT_STUN_URLS.map((urls) => ({ urls }));
}

function defaultIceServers(
  env: Env,
  turnCredentials: { username: string; password: string } | null
): IceServer[] {
  const stunUrls = cleanCSV(env.WEBRTC_STUN_URLS || DEFAULT_STUN_URLS.join(","));
  const extraStunUrls = cleanCSV(env.WEBRTC_EXTRA_STUN_URLS || "");
  const turnUrls = cleanCSV(env.WEBRTC_TURN_URLS || "");
  const staticTurnUrls = cleanCSV(env.WEBRTC_STATIC_TURN_URLS || "");
  const staticUsername = String(env.WEBRTC_STATIC_TURN_USERNAME || "").trim();
  const staticCredential = String(env.WEBRTC_STATIC_TURN_CREDENTIAL || "").trim();
  const servers: IceServer[] = [];

  for (const url of [...new Set([...stunUrls, ...extraStunUrls])]) {
    servers.push({ urls: url });
  }
  if (turnCredentials && turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: turnCredentials.username,
      credential: turnCredentials.password
    });
  }
  if (staticTurnUrls.length && staticUsername && staticCredential) {
    servers.push({
      urls: staticTurnUrls,
      username: staticUsername,
      credential: staticCredential
    });
  }
  return servers;
}

function mergeStunFallback(env: Env, turnServers: IceServer[]): IceServer[] {
  const stunUrls = cleanCSV(env.WEBRTC_STUN_URLS || DEFAULT_STUN_URLS.join(","));
  const extra = cleanCSV(env.WEBRTC_EXTRA_STUN_URLS || "");
  const stun = [...new Set([...stunUrls, ...extra])].map((urls) => ({ urls }));
  return [...turnServers, ...stun];
}


async function signedRelayIceServers(env: Env, identity: string): Promise<IceServer[]> {
  const endpoint = String(env.WEBRTC_RELAY_ISSUER_URL || "").trim();
  if (!endpoint || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return [];
  try {
    const destination = new URL(endpoint);
    if (destination.protocol !== "https:") return [];
    const publicRaw = decodeBase64Url(env.VAPID_PUBLIC_KEY);
    const secretRaw = decodeBase64Url(env.VAPID_PRIVATE_KEY);
    if (publicRaw.length !== 65 || publicRaw[0] !== 4 || secretRaw.length !== 32) return [];
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC", crv: "P-256",
        x: encodeBase64Url(publicRaw.slice(1, 33)),
        y: encodeBase64Url(publicRaw.slice(33, 65)),
        d: encodeBase64Url(secretRaw)
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const payload = `bulbam-turn-v1\n${timestamp}\n${identity}\n${nonce}`;
    const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(payload)
    )));
    const response = await fetch(destination.toString(), {
      method: "POST",
      headers: {
        "x-bulbam-timestamp": timestamp,
        "x-bulbam-user": identity,
        "x-bulbam-nonce": nonce,
        "x-bulbam-signature": signature
      },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) {
      console.warn(`[Calls] VPS TURN issuer returned HTTP ${response.status}`);
      return [];
    }
    const body = await response.json() as { iceServers?: unknown };
    if (!Array.isArray(body.iceServers)) return [];
    return body.iceServers.filter((candidate): candidate is IceServer =>
      isIceServer(candidate) && typeof candidate.username === "string" &&
      typeof candidate.credential === "string" &&
      [candidate.urls].flat().some((url) => typeof url === "string" && /^turns?:/i.test(url))
    );
  } catch {
    console.warn("[Calls] VPS TURN issuer not available, retaining STUN fallback");
    return [];
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const char of value) binary += String.fromCharCode(char);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function cloudflareTurnIceServers(env: Env): Promise<IceServer[]> {
  const keyId = String(env.WEBRTC_CLOUDFLARE_TURN_KEY_ID || env.TURN_KEY_ID || "").trim();
  const token = String(env.WEBRTC_CLOUDFLARE_TURN_API_TOKEN || env.TURN_KEY_API_TOKEN || "").trim();
  if (!keyId || !token) return [];

  const ttl = safeTtl(env.WEBRTC_TURN_TTL_SECONDS, 600, 60, 86_400);
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ttl })
      }
    );
    if (!response.ok) {
      console.warn(`[Calls] Cloudflare TURN returned HTTP ${response.status}`);
      return [];
    }
    const body = await response.json() as { iceServers?: unknown };
    if (!Array.isArray(body.iceServers)) return [];
    return body.iceServers.filter(isIceServer);
  } catch (error) {
    console.warn("[Calls] Cloudflare TURN request failed", error);
    return [];
  }
}

async function sharedSecretTurn(
  env: Env,
  identity: string
): Promise<{ username: string; password: string } | null> {
  const secret = env.WEBRTC_TURN_SECRET;
  if (!secret) return null;
  const ttl = safeTtl(env.WEBRTC_TURN_TTL_SECONDS, 600, 60, 3600);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const safeIdentity = String(identity || "unknown")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80) || "unknown";
  const username = `${expires}:${safeIdentity}`;
  return {
    username,
    password: await hmacSha1Base64(secret, username)
  };
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function cleanCSV(value: string): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeTtl(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function isIceServer(value: unknown): value is IceServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  const urls = server.urls;
  const validUrls = typeof urls === "string" ||
    (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === "string"));
  if (!validUrls) return false;
  if (server.username !== undefined && typeof server.username !== "string") return false;
  if (server.credential !== undefined && typeof server.credential !== "string") return false;
  return true;
}
