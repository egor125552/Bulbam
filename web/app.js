import { loadCurrentAccount, setupAuth } from "./js/auth.js";
import { setupAudioProfiles } from "./js/audio-profiles.js";
import { setupCalls } from "./js/calls.js";
import { checkServer, setupHealth } from "./js/health.js";
import { setupInvites } from "./js/invites.js";
import { setupMessenger } from "./js/messenger.js";
import { setupPushNotifications } from "./js/push.js";
import { setupSessions } from "./js/sessions.js";
import { setupVoicePlayer } from "./js/voice-player.js";
import { setupVoiceRecorder } from "./js/voice-recorder.js";
import { setupVoiceSettings } from "./js/voice-settings.js";

setupHealth();
setupAuth();
setupSessions();
setupInvites();
setupMessenger();
setupPushNotifications();
setupVoiceSettings();
setupVoicePlayer();
setupVoiceRecorder();
setupAudioProfiles();
setupCalls();

await checkServer();
await loadCurrentAccount({ quiet: false });
