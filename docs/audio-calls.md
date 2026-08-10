# One-to-one audio calls

Bulbam 0.5 adds browser-native one-to-one audio calls with WebRTC.

## Flow

1. The caller opens an existing direct chat and presses **Позвонить**.
2. Bulbam requests microphone permission before creating the ringing call.
3. The Worker stores the call in D1 and sends `call.ringing` through the existing per-user realtime Durable Object.
4. If the recipient's app is not in the foreground and Web Push is configured, the same call also produces an incoming-call push notification.
5. The recipient presses **Ответить**. Only after the server has accepted that transition does WebRTC signaling begin.
6. The caller creates the SDP offer, the recipient creates the SDP answer, and both sides exchange trickled ICE candidates.
7. Signaling events are both published in realtime and stored with a monotonically increasing sequence in D1. The client polls for missed signals as a fallback when the WebSocket briefly drops.
8. Either participant can end an accepted call. The recipient may decline while it is ringing.

## Media path

Audio is not sent through the Bulbam Worker. The browser uses `RTCPeerConnection` and encrypted WebRTC media. The first release returns Cloudflare's public STUN server:

`stun:stun.cloudflare.com:3478`

This is enough for many ordinary networks but not every NAT/firewall combination. For production-grade connectivity on restrictive networks, add Cloudflare Realtime TURN and issue short-lived TURN credentials from the server. Never expose the long-lived TURN key to browser JavaScript.

## Safety and state rules

- Only participants of the direct conversation can inspect the call.
- Only the callee can accept or decline a ringing call.
- Only the caller may send the WebRTC offer.
- Only the callee may send the WebRTC answer.
- Both participants may send ICE candidates after the call is accepted.
- A new call is rejected while either participant already has a ringing or accepted call.
- Abandoned ringing calls expire server-side after 90 seconds.
- An accepted call has an eight-hour emergency expiry so a browser crash cannot leave an account permanently busy.
- The client stops its microphone tracks locally even if the network disappears during hangup.

## Accessibility

The call controls are ordinary semantic buttons with explicit Russian labels. Incoming and connection state changes use existing `role=status`/live-region behavior rather than focus stealing. A call opened from a push notification moves focus to the call heading only after the authenticated application has loaded the referenced ringing call.
