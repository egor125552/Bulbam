import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseHTML } from "linkedom";

vi.mock("../web/js/settings-screens.js", () => ({ openSettingsScreen: vi.fn() }));
vi.mock("../web/js/api.js", () => ({ api: vi.fn(), deviceName: () => "iPhone" }));
vi.mock("../web/js/ui.js", () => ({
  announce: vi.fn(),
  getCurrentAccount: () => ({ role: "owner" }),
  showSignedIn: vi.fn()
}));
vi.mock("../web/js/sessions.js", () => ({ loadSessions: vi.fn() }));
vi.mock("../web/js/auth.js", () => ({ showRecoveryCodes: vi.fn() }));

import { setupAdminRecovery } from "../web/js/admin-recovery.js";
import { api } from "../web/js/api.js";
import { announce } from "../web/js/ui.js";

let requests;
let decisions;
let doc;
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function click(selector) {
  const node = doc.querySelector(selector);
  expect(node).toBeTruthy();
  node.dispatchEvent(new window.Event("click", { bubbles: true }));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ({ document: doc, window: globalThis.window } = parseHTML(`<html><body>
    <button id="settings-button">Настройки</button>
    <button id="admin-recovery-refresh">Обновить заявки</button>
    <section id="admin-recovery-queue" hidden>
      <p id="admin-recovery-queue-status" role="status" tabindex="-1"></p>
      <ul id="admin-recovery-requests"></ul>
    </section>
  </body></html>`));
  globalThis.document = doc;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn()
  };
  requests = [{
    requestId: "test-request-1", username: "friend", deviceName: "iPhone",
    verificationCode: "ABCD", createdAt: Date.now()
  }];
  decisions = [];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/v1/admin/recovery-requests") return { requests: [...requests] };
    if (path.endsWith("/decision")) {
      const decision = JSON.parse(options.body);
      decisions.push(decision);
      requests = requests.filter(req => !path.includes(req.requestId));
      return { ok: true };
    }
    throw new Error("Unexpected API path: " + path);
  });
  setupAdminRecovery();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.location;
  delete globalThis.history;
});

describe("approval checkbox and VoiceOver", () => {
  test("keeps the very same confirmed checkbox through settings clicks and periodic refresh", async () => {
    click("#settings-button");
    await flush();
    const checkbox = doc.querySelector("#admin-recovery-requests input[type=checkbox]");
    expect(checkbox).toBeTruthy();
    checkbox.checked = true;
    click("#settings-button");
    click("#admin-recovery-refresh");
    await flush();
    expect(doc.querySelector("#admin-recovery-requests input[type=checkbox]")).toBe(checkbox);
    expect(checkbox.checked).toBe(true);
    vi.advanceTimersByTime(30000);
    await flush();
    expect(doc.querySelector("#admin-recovery-requests input[type=checkbox]")).toBe(checkbox);
    expect(checkbox.checked).toBe(true);
  });
  test("opens a reset link immediately and removes its secret from the address",async()=>{
    const id="00000000-0000-0000-0000-000000000001";
    const secret="ar_"+"b".repeat(64);
    globalThis.location=new URL("https://bulbam.test/#recoveryId="+id+"&recoveryToken="+secret);
    const changes=[];
    globalThis.history={replaceState:(_state,_title,url)=>changes.push(url)};
    const section=doc.createElement("section");
    section.id="auth-view-recovery";
    section.hidden=true;
    section.innerHTML=`
      <div id="admin-recovery-progress" hidden>
        <p id="admin-recovery-state"></p>
        <form id="admin-recovery-complete" hidden>
          <input name="newPassword" type="password">
          <button type="submit">Установить пароль</button>
        </form>
      </div>`;
    doc.body.append(section);
    vi.mocked(api).mockImplementation(async path=>{
      if(path==="/api/v1/auth/admin-recovery/status")
        return {ok:true,status:"approved",expiresAt:Date.now()+15*60_000};
      if(path==="/api/v1/admin/recovery-requests")return {requests:[]};
      throw new Error("unexpected path "+path);
    });
    setupAdminRecovery();
    await flush();
    expect(changes).toEqual(["/"]);
    expect(doc.querySelector("#auth-view-recovery").hidden).toBe(false);
    expect(doc.querySelector("#admin-recovery-complete").hidden).toBe(false);
    expect(doc.querySelector("#auth-view-recovery").dataset.recoveryLink).toBe("active");
    expect(doc.querySelector("#admin-recovery-state").textContent).toContain("Администратор подтвердил");
  });
  test("requires identity confirmation and then submits approval with confirmed state", async () => {
    click("#settings-button");
    await flush();
    click("#admin-recovery-requests button");
    await flush();
    expect(decisions).toHaveLength(0);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(expect.stringContaining("флажком"));
    doc.querySelector("#admin-recovery-requests input").checked = true;
    click("#admin-recovery-requests button");
    await flush();
    expect(decisions).toEqual([{ approve: true, verifiedIdentity: true }]);
    expect(doc.querySelector("#admin-recovery-queue-status").textContent).toContain("одобрена");
    expect(doc.querySelector("#admin-recovery-requests").children).toHaveLength(0);
  });
});