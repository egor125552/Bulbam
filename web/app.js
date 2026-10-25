import { setupI18n } from "./js/i18n.js";
import { setupDiagnostics } from "./js/diagnostics-ui.js";
import { setupDetailedDiagnostics } from "./js/diagnostics-runtime.js";
import { setupDetailedHelp } from "./js/accessibility-help.js";
import { setupSettingsScreens } from "./js/settings-screens.js";
import { setupWelcome } from "./js/welcome.js";
import { setupAdminRecovery } from "./js/admin-recovery.js";
import { loadCurrentAccount, setupAuth } from "./js/auth.js";
import { setupAudioProfiles } from "./js/audio-profiles.js";
import { setupFinishedCallPanelCleanup } from "./js/call-finished-panel.js";
import { setupCalls } from "./js/calls.js";
import { checkServer, setupHealth } from "./js/health.js";
import { setupInvites } from "./js/invites.js";
import { setupMessageAnnouncements } from "./js/message-announcements.js";
import { setupMessageScroll } from "./js/message-scroll.js";
import { setupComposerViewport } from "./js/composer-viewport.js";
import { setupMessenger } from "./js/messenger.js";
import { setupPushNotifications } from "./js/push.js";
import { setupPresence } from "./js/presence.js";
import { setupSessions } from "./js/sessions.js";
import { setupAppleVoiceRecordingPreference } from "./js/voice-apple-recording.js";
import { setupVoicePlayer } from "./js/voice-player.js";
import { setupVoiceRecorder } from "./js/voice-recorder.js";
import { setupVoiceSettings } from "./js/voice-settings.js";
import { setupVoiceWebKitTimelineFix } from "./js/voice-webkit-timeline.js";

export function startApp() {
  setupI18n();
  setupDiagnostics();
  setupDetailedDiagnostics();
  setupDetailedHelp();
  setupSettingsScreens();
  setupHealth();
  setupAuth();
  setupAdminRecovery();
  setupWelcome();
  setupSessions();
  setupInvites();
  setupMessenger();
  setupMessageAnnouncements();
  setupMessageScroll();
  setupComposerViewport();
  setupPushNotifications();
  setupPresence();
  setupVoiceSettings();
  setupVoicePlayer();
  setupVoiceWebKitTimelineFix();
  setupAppleVoiceRecordingPreference();
  setupFinishedCallPanelCleanup();
  setupVoiceRecorder();
  setupAudioProfiles();
  setupCalls();

  // Login is the only critical API request at startup. Health checks remain
  // available on demand, but must not block account/chat initialization.
  void loadCurrentAccount({ quiet: false });
}
