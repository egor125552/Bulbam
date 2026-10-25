# Bulbam

Bulbam is an accessible, web-first messenger focused on reliable realtime communication.

The project is intentionally building the communication core first: accounts, persistent direct messages, realtime delivery, notifications, audio calls, multi-device behavior, accessibility, and recovery from unreliable networks. Product experiments and the broader Bulbam identity come later, after the core is trustworthy.

## What works today

- invite-based registration, stable user IDs, roles, and separate device sessions;
- PBKDF2 password hashing;
- persistent one-to-one conversations and messages stored in Cloudflare D1;
- idempotent message sending with client-generated message IDs to prevent duplicates after retries;
- server-side delivery confirmation;
- per-user Durable Objects and WebSockets for realtime events;
- polling fallback when the realtime connection is unavailable;
- Web Push for new messages and incoming calls;
- one-to-one WebRTC audio calls;
- ICE, STUN, TURN, and call recovery for some network failures;
- an accessible web/PWA interface designed for keyboard and screen-reader use, including VoiceOver.

The current product priority is to finish multi-device and read-state behavior, strengthen authentication and session handling, add media and voice messages, improve safety features, and continue real-world network testing.

For a concise English product and technical overview, see `docs/overview.md`.

The detailed development order is documented in `docs/roadmap.md`.

The broader Bulbam product vision, including Belarusian identity, anti-fraud ideas, groups, channels, potato-themed features, gifts, coupons, and possible international growth, is documented in `docs/product-vision.md`.

## Architecture

Bulbam is a modular monolith: one repository and one deployable Cloudflare Worker, with strict boundaries between business domains.

Server modules live under `worker/src/modules/<domain>/` and are split into:

- `domain/` — pure models and invariants;
- `application/` — use cases;
- `ports/` — abstract dependencies;
- `infrastructure/` — D1, R2, Cloudflare, and other adapters;
- `transport/` — HTTP and WebSocket boundaries.

The codebase currently contains separate domains for identity, messaging, realtime, notifications, and calls.

D1 is the source of truth for persistent data. Durable Objects coordinate live connections and call state, but they do not replace durable message storage.

`worker/src/index.ts` remains a thin Worker entry point. `worker/src/app.ts` wires dependencies together. SQL should stay inside infrastructure adapters.

See `docs/architecture.md` and `AGENTS.md` for implementation rules.

## Product principles

- The server is the source of truth for accounts and messages.
- A message is considered sent only after server acknowledgement.
- Retrying after a connection failure must not create duplicate messages.
- Browser storage is only a cache and outbox, not the durable source of truth.
- Large media files must not be sent inline or as base64 over WebSocket.
- Accessibility with VoiceOver and keyboard navigation is tested from the beginning.
- Security and accessibility take priority over decorative features.
- Marketing must not promise behavior that has not been confirmed by tests and real use.

## Repository structure

- `web/` — accessible browser client and ES modules;
- `worker/src/core/` — shared technical primitives;
- `worker/src/platform/` — Cloudflare binding contracts;
- `worker/src/modules/` — business domains;
- `shared/` — shared protocol contracts;
- `docs/overview.md` — English project overview;
- `docs/architecture.md` — architecture and module boundaries;
- `docs/audio-calls.md` — audio call design;
- `docs/push-notifications.md` — Web Push setup and behavior;
- `docs/roadmap.md` — current development roadmap;
- `docs/product-vision.md` — long-term product concept and experimental ideas.

## Run locally

```bash
npm install
npm run dev
```

Run verification:

```bash
npm run verify
```

API smoke endpoints:

```text
GET /api/health
GET /api/ready
```

Production Worker: `bulbam-api`.

Live deployment:

https://bulbam-api.k69ysrndm7.workers.dev

## Reliability and accessibility

Bulbam treats unreliable networks and accessibility as normal operating conditions, not edge cases.

The client is expected to recover from reloads, retries, temporary WebSocket loss, and reconnects without silently duplicating durable messages. The interface is built around semantic controls, keyboard access, meaningful status text, and screen-reader compatibility.

Audio calls follow the same rule: realtime is the fast path, but short signaling interruptions should not immediately destroy the call state.

## Current limitations

Bulbam is still under active development.

The following features are not yet complete and should not be presented as finished:

- полная синхронизация состояния прочтения между несколькими устройствами одного пользователя;
- full attachment support and channels (voice messages and groups already exist);
- blocking, reporting, and the full trust-and-safety layer;
- audited, automatically managed multi-device end-to-end encryption (an opt-in shared-key encrypted mode exists for direct text and voice);
- video calls;
- large-scale production hardening.

By default, ordinary chats remain unencrypted at rest on the server. Direct chats can opt into experimental on-device AES-GCM encryption for new text and voice, with a manually exchanged secret and a server-enforced block on new plaintext. Prior messages, groups and calls are not protected by this mode. It is not Signal Protocol and has not received an independent security audit. See `docs/message-encryption-experimental.md`. The simplified UI intentionally hides verbose encryption state labels; legacy keys remain recoverable in the Protection dialog. A signed per-device identity registry (including pending-device approval and revocation) is implemented, but **not wired to message ciphertext delivery**. It does not change the existing E2EE mode or unlock history on new devices. See `docs/e2ee-device-identity-v1.md`. A second per-device authenticated encrypted-envelope transport now has a real Cloudflare Worker/D1 roundtrip and local encrypted inbox, documented in `docs/e2ee-device-envelopes-v2.md`; it is **not** yet a Signal-grade Double Ratchet. In the experimental E2EE v2 branch, ordinary direct-message and voice sending uses this per-device encrypted transport when protection is available and not explicitly disabled; group chats, calls and old message history remain on their previous paths. The v2 branch is not deployed or independently audited. Full Signal-grade per-device key management is **not** implemented; requirements and security gates are documented in `docs/encryption-next-generation.md`. Owner-controlled feature visibility and reversible protection mode for individual direct chats are documented in `docs/owner-feature-controls.md`. Experimental opt-in automatic ECDH key agreement for direct chats is described in `docs/automatic-key-exchange.md`; it currently supports just the first enrolled device per account, with no device linking or lost-device recovery.

## Project direction

Bulbam is deliberately avoiding the common prototype trap of adding many visible features while the communication core remains fragile.

The development order is:

1. reliable direct communication;
2. trust, safety, privacy, and device management;
3. groups and controlled channels;
4. Bulbam-specific social and playful features;
5. regional ecosystem and partnerships;
6. possible international growth.

Each layer must preserve the reliability and accessibility of the layers below it.
