import { describe, expect, test } from "vitest";
import { parseHTML } from "linkedom";
import { setupComposerViewport } from "../web/js/composer-viewport.js";

function createFixture() {
  const { document, window } = parseHTML('<html><body><form id="message-form"><textarea id="message-input"></textarea></form></body></html>');
  const listeners = new Map();
  const viewport = {
    height: 760,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(type) { listeners.get(type)?.(); }
  };
  const appWindow = { visualViewport: viewport };
  return { document, window, viewport, appWindow };
}

describe("iPhone text input with an onscreen keyboard", () => {
  test("resizes the chat to the visible keyboard-free viewport and restores it on blur", () => {
    const { document, window, viewport, appWindow } = createFixture();
    const cleanup = setupComposerViewport({ document, window: appWindow });
    const field = document.querySelector("#message-input");
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("");
    field.dispatchEvent(new window.Event("focus"));
    // Focus itself must NOT relayout the textarea. On iOS that can cancel
    // VoiceOver activation / the software keyboard before it opens.
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("");
    viewport.height = 405;
    viewport.dispatch("resize");
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("405px");
    viewport.height = 760;
    viewport.dispatch("resize");
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("760px");
    field.dispatchEvent(new window.Event("blur"));
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("");
    cleanup();
  });

  test("does not resize the chat when not editing a message or without visualViewport", () => {
    const { document, window, viewport, appWindow } = createFixture();
    const cleanup = setupComposerViewport({ document, window: appWindow });
    viewport.height = 310;
    viewport.dispatch("resize");
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("");
    cleanup();
    expect(setupComposerViewport({ document, window: {} })).toBeTypeOf("function");
    document.querySelector("#message-input").dispatchEvent(new window.Event("focus"));
    expect(document.documentElement.style.getPropertyValue("--bulbam-usable-height")).toBe("");
  });
});
