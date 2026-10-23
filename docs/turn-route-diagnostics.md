# TURN route diagnostics (temporary opt-in)

The Bulbam **Settings → Diagnostics** screen displays the **selected WebRTC
ICE candidate pair**, not a guess based on whether a TURN server exists.

- **TURN (relay)** means that the selected local or remote candidate is
  `relay`. The call is being relayed.
- **STUN / direct** means that a selected candidate is `srflx` or `prflx`
  and neither candidate is `relay`. The media is sent directly between peers.
- **Direct (host)** means both selected candidates are `host`.
- **Unknown** means the browser does not yet expose a selected candidate pair.

The diagnosis uses `RTCPeerConnection.getStats()`, so it is available only
once the browser has established a WebRTC peer connection. No remote/local
candidate IPs, TURN usernames or credentials are shown.

## Temporary relay-only call

In **Settings → Diagnostics**, enable **Use TURN only for new calls**.
This selects the browser WebRTC `iceTransportPolicy: "relay"` for new peer
connections. The choice is stored only in **sessionStorage** for the current
browser tab, and the default remains `all`.

The UI checks the authenticated `/api/v1/calls/ice` endpoint first.
If it does not provide TURN servers, it refuses to enable the setting
and leaves automatic routing on. **Do not enable TURN-only for everybody
at the server level.** If TURN is slow or unreachable, users need STUN
as a fallback.

This option applies to **subsequent calls**, not a currently established
WebRTC connection. Turn it off in Diagnostics to restore automatic routing.

## Using the existing coturn VPS

The VPS already hosts coturn on UDP/TCP port 3478. The Worker must supply
short-lived TURN credentials to authorized clients, or the browser cannot
allocate a relay candidate merely because coturn is installed.

Configure the Cloudflare Worker secrets/bindings with:

- `WEBRTC_TURN_URLS=turn:169.58.224.216:3478?transport=udp,turn:169.58.224.216:3478?transport=tcp`
- `WEBRTC_TURN_SECRET` as a **Cloudflare secret binding**, matching coturn's
  **existing** shared authentication secret (never print, paste into GitHub,
  or commit either secret).

When valid self-hosted TURN URLs and credentials are configured, the Worker
prefers VPS coturn to Cloudflare TURN. Otherwise it preserves existing
Cloudflare TURN and STUN fallbacks.

Do not set `turns:` until coturn has a tested TLS listener/certificate.
A running coturn process or successful STUN binding response does not
by itself prove authenticated TURN relaying works. Verify an actual call
in the browser with Diagnostics showing **TURN (relay)**.

Cloudflare deployment is managed by **Cloudflare Workers Builds** from
`main`; GitHub Actions verifies only. A feature branch alone does not
deploy to production.
