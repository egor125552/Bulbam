# Headset microphone controls and fast reconnect

During an active audio call Bulbam registers the standard Media Session conferencing actions `togglemicrophone` and `hangup`, plus `play`/`pause` fallbacks for headset media buttons. These actions mute the local WebRTC `MediaStreamTrack` or terminate the same call as the on-screen controls. The Media Session microphone-active state is updated after each mute change; all handlers are unregistered at call completion. Unsupported actions fail gracefully, and not all Bluetooth accessories or Safari builds forward hardware clicks to web pages. This does **not** change hardware-level microphone switches that the browser cannot observe.

A browser `online` event now attempts reconnection immediately after offline, independently of the 12-second watchdog. On mobile browser handover, optional `NetworkInformation.change`, `focus`, `pageshow`, and page visibility also check for stuck calls. Reconnection while an SDP offer is in progress is queued until the current offer finishes; the existing recovery gate prevents duplicate simultaneous offers. Ordinary brief ICE disconnected blips retain the 2.5-second recovery grace. A freshly captured microphone track inherits the current mute state.

The watchdog remains a safety fallback when no browser network signal is generated, not an artificial minimum wait after internet returns.
