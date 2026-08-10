import { loadCurrentAccount, setupAuth } from "./js/auth.js";
import { checkServer, setupHealth } from "./js/health.js";
import { setupInvites } from "./js/invites.js";
import { setupSessions } from "./js/sessions.js";

setupHealth();
setupAuth();
setupSessions();
setupInvites();

await checkServer();
await loadCurrentAccount({ quiet: false });
