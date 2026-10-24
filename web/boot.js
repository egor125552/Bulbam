// One boot entrypoint ensures a single instance of UI, i18n and call modules.
import { setupInterface } from "./js/ui.js";
import { setupCanonicalInterface } from "./js/canonical-interface.js";
import { startApp } from "./app.js";

setupInterface();
setupCanonicalInterface();
document.querySelector("#logout")?.addEventListener("click", () =>
  document.querySelector("#settings-dialog")?.close?.());
startApp();
