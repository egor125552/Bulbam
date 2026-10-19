import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseHTML } from "linkedom";

describe("global detailed help preference", () => {
  beforeEach(() => {
    vi.resetModules();
    const parsed = parseHTML('<html><body><div id="live-status"></div><input id="voice-detailed-help" type="checkbox" checked><p id="static-help" class="hint">Длинное пояснение</p><p id="dynamic-status" class="hint" role="status">Важный статус</p><p id="voice-record-hint">Как записывать</p><button id="record" aria-describedby="voice-record-hint dynamic-status">Запись</button></body></html>');
    globalThis.window = parsed.window;
    globalThis.document = parsed.window.document;
    globalThis.CustomEvent = parsed.window.CustomEvent;
    const values = new Map();
    globalThis.localStorage = {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key)
    };
  });

  test("switch disables static hints but preserves important status descriptions", async () => {
    const { setupDetailedHelp } = await import("../web/js/accessibility-help.js");
    setupDetailedHelp();
    const toggle = document.querySelector("#voice-detailed-help");
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event("change"));
    expect(document.documentElement.dataset.detailedHelp).toBe("false");
    expect(document.querySelector("#static-help").dataset.detailedHelp).toBe("true");
    expect(document.querySelector("#dynamic-status").dataset.detailedHelp).toBeUndefined();
    expect(document.querySelector("#record").getAttribute("aria-describedby")).toBe("dynamic-status");
    expect(localStorage.getItem("bulbam.accessibility.detailedHelp")).toBe("false");
  });
});
