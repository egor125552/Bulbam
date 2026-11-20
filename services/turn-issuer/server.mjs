import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  createRequestGate,
  issueTurnCredentials,
  readCoturnSecret,
  validateSignedRequest,
  vapidPublicKey
} from "./issuer.mjs";

const port = Number(process.env.PORT || 18879);
const key = vapidPublicKey(readFileSync(process.env.PUBLIC_KEY_FILE || "/etc/bulbam-relay-issuer/public-key", "utf8"));
const secret = readCoturnSecret(readFileSync(process.env.TURN_CONFIG_FILE || "/etc/turnserver.conf", "utf8"));
const accept = createRequestGate();
const urls = (process.env.TURN_URLS || "turn:169.58.224.216:3478?transport=udp,turn:169.58.224.216:3478?transport=tcp")
  .split(",").map((url) => url.trim()).filter((url) => /^turns?:/.test(url));

if (!urls.length) throw new Error("TURN_URLS is empty");

function respond(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    respond(res, 200, { ok: true, service: "bulbam-turn-issuer" });
    return;
  }
  if (req.method !== "POST" || req.url !== "/credentials") {
    respond(res, 404, { ok: false });
    return;
  }
  const proof = validateSignedRequest(req.headers, key);
  if (!proof) {
    respond(res, 403, { ok: false });
    return;
  }
  if (!accept(proof.identity, proof.nonce)) {
    respond(res, 429, { ok: false });
    return;
  }
  respond(res, 200, { ok: true, ...issueTurnCredentials(secret, proof.identity, Date.now(), urls) });
}).listen(port, "127.0.0.1", () => {
  console.log("Bulbam TURN issuer listening on loopback");
});
