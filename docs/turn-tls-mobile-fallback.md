# Mobile TURN fallback and call teardown (2026-10-23)

The self-hosted coturn relay accepts UDP and TCP on 3478 and authenticated TURN over TLS on 5349. The TLS SNI multiplexer on the server's public port 443 routes only `turn.169-58-224-216.sslip.io` to coturn; the existing HTTPS site and the VPN Reality hostname retain their respective routes. Caddy issues and renews a public certificate for the TURN hostname. The enabled `bulbam-turn-cert-sync.timer` checks for renewed certificate/key material every 6 hours and restarts coturn on change. Certificates are copied with restricted permissions, not placed in the repository.

The VPS-issued ephemeral ICE credentials now contain `turns:turn.169-58-224-216.sslip.io:443?transport=tcp` before the original UDP/TCP 3478 routes. These URLs are public; the HMAC signing key never leaves the server. The issuer health probe does not publish credentials.

Use `systemctl is-active coturn bulbam-relay-issuer egor-sni-mux caddy` and `systemctl is-enabled bulbam-turn-cert-sync.timer` for operational checks. For a public SNI check, use TLS hostname verification and a STUN binding through port 443; a TURN utility without TLS SNI cannot validate that shared-port route. The production test still requires an actual browser-to-browser call from the affected mobile network.

When WebRTC ICE never connects, simultaneous recovery triggers are coalesced rather than issuing overlapping SDP offers. Ending a call from any authenticated session of either participant is permitted, immediately releases local media, updates the room state, frees both active call slots, and publishes `call.ended` to all sessions. When a backgrounded iPhone becomes visible, the client checks the server's call state to catch missed hangup notifications.
