# Unprocessed microphone capture, hot switching and unified diagnostics

## Voice message recording

Voice messages request `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, 48 kHz (ideal), and stereo when supported (ideal, not a hard requirement). `keepVoiceRaw` re-applies the settings to the captured track and reads back `getSettings()`, reporting verified and unknown/unchanged processing without lying about Android/iOS audio stacks. No Bulbam DSP, normalizer, noise gate, mono downmix or effects are applied. This does not bypass hardware/audio-driver processing, nor does it guarantee lossless PCM; `MediaRecorder` encodes the selected WebM/MP4/Ogg audio codec. The maximum selectable encoded bitrate is now 192 kbps, but low bitrate modes stay for slow networks, and the codec or OS may produce a different actual bitrate.

## Live call quality changes

The selected capture profile is acquired as a fresh track and installed with `RTCRtpSender.replaceTrack()` without an SDP renegotiation, avoiding the Android-specific failure mode in which applying constraints to a running track leaves its existing capture pipeline unchanged. The old track is stopped only after a successful replacement. On failure or obsolete requests it is retained or restored. Changing the profile does not terminate an active call. Unsupported senders keep the old `applyConstraints` fallback; actual processing state is reported as available from `getSettings()`.

## Unified diagnostics

Settings → Diagnostics now includes one chronological text trace with copy, TXT download and clear controls. It records supported UI action IDs and settings navigation, client API request categories and response status/duration, WebRTC call events, connectivity and message-socket state, microphone processing checks, voice draft and audio encoding/upload acknowledgments. No raw URLs, query parameters, user content, conversation identifiers, sender names, SDP/ICE candidates, IP addresses, TURN credentials, audio or authorization headers are written. The trace is bounded to 900 events, lives only in browser-tab memory and is not sent to another server. Buttons and the journal are reachable with VoiceOver. Internal Cloudflare/server-side execution traces are **not** available here; server-related entries represent returned HTTP statuses and authenticated WebSocket acknowledgments.
