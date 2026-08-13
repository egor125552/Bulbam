import { afterEach, describe, expect, test, vi } from "vitest";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

describe("voice buffering announcements", () => {
  test("does not surface a short prepare/resume cycle before playback", async () => {
    vi.useFakeTimers();
    const { announce, liveStatus } = await loadUi();

    announce("Буферизация голосового сообщения.");
    vi.advanceTimersByTime(200);
    announce("Воспроизведение голосового продолжено.");
    vi.advanceTimersByTime(500);

    expect(liveStatus.textContent).toBe("");
  });

  test("announces a real longer buffering pause but clears it after resume", async () => {
    vi.useFakeTimers();
    const { announce, liveStatus } = await loadUi();

    announce("Буферизация голосового сообщения.");
    vi.advanceTimersByTime(350);
    expect(liveStatus.textContent).toBe("Буферизация голосового сообщения.");

    announce("Воспроизведение голосового продолжено.");
    expect(liveStatus.textContent).toBe("");
  });
});

async function loadUi() {
  const liveStatus = { textContent: "" };
  globalThis.document = {
    querySelector(selector) {
      if (selector === "#live-status") return liveStatus;
      return {
        textContent: "",
        hidden: false,
        replaceChildren() {}
      };
    }
  };
  globalThis.window = { dispatchEvent() {} };
  vi.resetModules();
  const module = await import("../web/js/ui.js");
  return { announce: module.announce, liveStatus };
}