# Bulbam overview

## What is Bulbam?

Bulbam is an accessible web-first messenger built around one simple requirement: basic communication should keep working when the network, browser, or device is less than perfect.

It currently focuses on direct messaging and one-to-one audio calls rather than trying to imitate every feature of a large social platform at once.

The product is developed as a Progressive Web App backed by a Cloudflare Worker.

## What can a tester do today?

A tester can:

- create or use an invited account;
- sign in from a browser;
- search for another user;
- open a persistent one-to-one conversation;
- send text messages;
- reload or reconnect without intentionally creating duplicate messages;
- receive server delivery acknowledgement;
- receive realtime updates over WebSocket;
- continue receiving updates through fallback polling when WebSocket is unavailable;
- enable Web Push notifications;
- make and receive one-to-one WebRTC audio calls;
- use the interface with keyboard navigation and screen readers such as VoiceOver.

Some of these areas are still being hardened, especially multi-device behavior and network recovery.

## Why is the project structured this way?

Messaging prototypes often appear to work while both users are online on a fast connection. Problems become visible later:

- a retry creates the same message twice;
- one device shows a message while another device still shows old state;
- a lost WebSocket silently stops updates;
- a reload destroys a live call;
- a screen reader receives unclear or outdated status messages.

Bulbam treats those cases as part of the main product rather than as future cleanup.

## Messaging model

Persistent message data is stored in Cloudflare D1.

The client generates a unique message identifier before sending. If a request is retried after a network interruption, the server can recognize that the operation was already processed instead of inserting a duplicate message.

A message is not treated as successfully sent only because it appeared optimistically in the browser. The server must acknowledge it.

Realtime delivery uses per-user Durable Objects and WebSockets. If realtime is temporarily unavailable, the client can fall back to ordinary requests so that a broken socket is not automatically equivalent to a broken messenger.

## Audio calls

Bulbam supports one-to-one browser audio calls through WebRTC.

The Cloudflare Worker coordinates signaling, while the media path normally travels directly between peers or through TURN when a direct route is unavailable.

The call system supports:

- offer, answer, and ICE signaling;
- STUN and TURN;
- short-lived TURN credentials where configured;
- incoming-call Web Push;
- recovery after some signaling interruptions;
- ICE restart;
- a harder peer-connection rebuild as a fallback;
- explicit microphone recovery after a full page reload.

The project does not claim that calls are perfect under every network condition. Cross-device and poor-network testing remains active work.

For more detail, see `audio-calls.md`.

## Accessibility

Accessibility is a product requirement rather than a final polishing pass.

The web client is designed around semantic controls, keyboard navigation, readable status text, and screen-reader use. VoiceOver is a primary test scenario.

This matters especially for realtime interfaces. A visual state change is not enough if a screen-reader user never hears it, and repeated status announcements are not useful if they cause old information to be spoken after it has already lost meaning.

## Architecture

Bulbam uses a modular monolith.

That means the project keeps one deployable Worker and one repository, while business areas remain separated internally.

Current domains include:

- identity;
- messaging;
- realtime;
- notifications;
- calls.

Each domain separates business rules from platform-specific storage and transport code.

This keeps deployment simple while making it possible to change or replace one subsystem without turning the codebase into one giant file of mutually dependent behavior.

## Cloudflare services

The project currently relies on Cloudflare infrastructure including:

- Workers for the application backend;
- D1 for persistent relational data;
- Durable Objects for live per-user and per-conversation coordination;
- WebSockets for realtime events;
- Web Push for background notifications.

Future media support is intended to use object storage rather than embedding large files into realtime messages.

## Reliability rules

Bulbam follows several non-negotiable rules:

- persistent server state wins over browser cache;
- retries must be safe;
- a realtime connection is an optimization, not the only source of truth;
- local browser storage must not become the only copy of important data;
- poor network conditions must be tested intentionally;
- a feature is not ready just because the happy path works once;
- accessibility regressions are product regressions.

## What is not finished yet?

The following are active or future work:

- complete read-state synchronization;
- stronger multi-device semantics;
- media uploads;
- voice messages;
- blocking and reporting;
- anti-spam and anti-fraud systems;
- groups;
- channels;
- broader privacy and encryption design;
- video calls;
- production-scale hardening.

Current stored text messages are not end-to-end encrypted and should not be described that way.

## Long-term direction

Bulbam starts with communication reliability and accessibility.

Later layers may include groups, controlled channels, trust and safety systems, regional services, and a distinct Belarusian Bulbam identity with playful potato-themed features.

Those ideas are intentionally separated from the current feature list so experiments are not confused with shipped functionality.

## Running the project

Install dependencies:

```bash
npm install
```

Start local development:

```bash
npm run dev
```

Run verification:

```bash
npm run verify
```

Health endpoints:

```text
GET /api/health
GET /api/ready
```

## Links

Repository:

https://github.com/egor125552/Bulbam

Live deployment:

https://bulbam-api.k69ysrndm7.workers.dev
