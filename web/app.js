import { loadCurrentAccount, setupAuth } from "./js/auth.js";
import { checkServer, setupHealth } from "./js/health.js";
import { setupInvites } from "./js/invites.js";
import { setupMessenger } from "./js/messenger.js";
import { setupPushNotifications } from "./js/push.js";
import { setupSessions } from "./js/sessions.js";

setupHealth();
setupAuth();
setupSessions();
setupInvites();
setupMessenger();
setupPushNotifications();

await checkServer();
await loadCurrentAccount({ quiet: false });
