# One-to-one audio calls

Bulbam 0.5 adds browser-native one-to-one audio calls with WebRTC.

## Architecture

The call subsystem deliberately follows the working Lenovo Messenger relay pattern: durable messenger data and live call state are different things.

- D1 remains the source of truth for accounts, direct conversations, messages and delivery receipts.
- `UserRealtime` remains the per-user WebSocket fanout channel for live events.
- `CallRoom` is a separate Durable Object, addressed by `conversationId`, and is the source of truth for the current live call in that direct conversation.
- Each conversation gets its own CallRoom instead of putting every Bulbam user into one global room. This keeps the simple Lenovo Messenger call-state model without creating a global bottleneck.
- CallRoom storage keeps the live call record and a bounded recent signaling buffer. It survives Durable Object hibernation and allows a reconnecting browser to recover missed SDP/ICE signaling.
- Calls are intentionally not persisted as ordinary message history yet. Historical call records can be added later as a separate durable event/history layer without making D1 the live call coordinator.

## Flow

1. The caller opens an existing direct chat and presses **Позвонить**.
2. Bulbam requests microphone permission.
3. The Worker authenticates the user and confirms membership of that direct conversation.
4. The conversation's CallRoom creates a `ringing` call and publishes `call.ringing` through the recipient's `UserRealtime` Durable Object.
5. If the recipient is not in the foreground and Web Push is configured, the server also sends an incoming-call push deep-linked to both the conversation and the call.
6. The recipient presses **Ответить**. CallRoom atomically transitions the call from `ringing` to `accepted` and publishes `call.answered`.
7. The caller creates the SDP offer, the recipient creates the SDP answer, and both sides exchange trickled ICE candidates through CallRoom.
8. CallRoom forwards each signal immediately through realtime and retains only a bounded recent sequence so a short WebSocket interruption can recover by HTTP polling.
9. Either participant can end an accepted call. Only the recipient can decline a ringing call.

## Media path

The Bulbam Worker does not normally carry the audio itself. The browser uses `RTCPeerConnection`; media travels peer-to-peer when possible or through TURN when direct connectivity is impossible.

ICE configuration mirrors Lenovo Messenger's server strategy:

1. Cloudflare TURN with short-lived credentials generated server-side, when a TURN key ID/API token is configured.
2. coturn/shared-secret time-limited credentials when `WEBRTC_TURN_SECRET` and `WEBRTC_TURN_URLS` are configured.
3. static TURN credentials as an optional deployment fallback.
4. multiple STUN servers when no relay is required or configured.

Long-lived TURN credentials are never sent to the browser. The browser receives only the ICE server list and short-lived credentials needed for its current connection attempt.

## CallRoom lifecycle

- One active call is allowed per direct conversation CallRoom.
- Ringing calls have a short server-side expiry so a crashed caller cannot leave the room ringing forever.
- Accepted calls have a two-hour emergency TTL, matching the live-state philosophy of Lenovo Messenger: a stale live record is cleaned up rather than treated as permanent history.
- Ending or declining clears the retained signaling buffer.
- A finished call may be replaced by the next call in the same conversation.

## Authorization

- Only members of the direct conversation may address its CallRoom through the public API.
- Only the callee can accept or decline a ringing call.
- Only the caller can submit the WebRTC offer.
- Only the callee can submit the WebRTC answer.
- Either participant can submit ICE candidates after acceptance and either can hang up.
- Internal CallRoom routes are reached only through the Worker Durable Object binding; browsers never receive a direct internal CallRoom URL.

## Reliability

Realtime is the fast path, not the sole source of truth. Recent signaling has monotonically increasing sequence numbers in CallRoom storage. If the WebSocket disappears briefly, the client polls from its last sequence and processes only missing signals. This keeps the Lenovo-style realtime design while avoiding an unnecessary call failure from a momentary socket interruption.

## Push and accessibility

Incoming call Web Push points to `?chat=<conversationId>&call=<callId>`. After authentication the PWA can restore the CallRoom state and present **Ответить** / **Отклонить**.

Call controls use semantic buttons and text status. VoiceOver does not need a separate visual-only control path. The call heading can receive focus when a call is explicitly opened from a push notification, while ordinary realtime state changes are announced through the existing polite status channel.
