import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const { document } = parseHTML(html);

describe("VoiceOver navigation on long chats", () => {
  test("preserves the original history-before-composer order without rearranging VoiceOver", () => {
    const pane = document.querySelector(".conversation-pane");
    const nodes = [...pane.querySelectorAll("*")];
    const index = (id) => nodes.indexOf(document.getElementById(id));
    expect(index("call-start")).toBeLessThan(index("message-list"));
    expect(index("message-list")).toBeLessThan(index("message-input"));
    expect(index("message-input")).toBeLessThan(index("voice-record-button"));
    expect(index("voice-record-button")).toBeLessThan(index("send-message"));
  });

  test("keeps chat buttons visible by constraining viewport and scrolling history only", () => {
    const css = readFileSync(new URL("../web/canonical-ui.css", import.meta.url), "utf8");
    expect(css).toMatch(/body\.signed-in-mode\s*\{[^}]*min-height:\s*0;[^}]*height:\s*var\(--bulbam-usable-height, 100dvh\)/);
    expect(css).not.toMatch(/body\.signed-in-mode\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.signed-in-mode \.composer\s*\{[^}]*z-index:\s*4/);
    expect(css).toMatch(/\.signed-in-mode \.messenger-shell\s*\{[^}]*height:\s*calc\(var\(--bulbam-usable-height, 100dvh\) - 1\.2rem\)/);
    expect(css).toMatch(/\.signed-in-mode \.conversation-pane\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.signed-in-mode \.message-list\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 48rem\)[\s\S]*?\.signed-in-mode \.messenger-shell\s*\{[^}]*height:\s*var\(--bulbam-usable-height, 100dvh\)/);
  });

  test("diagnostics count is visible on demand but never announces every event", () => {
    const counter = document.querySelector("#diagnostics-count");
    expect(counter.getAttribute("aria-live")).toBe("off");
    expect(counter.getAttribute("role")).not.toBe("status");
    expect(document.querySelector("#diagnostics-log").getAttribute("aria-live")).toBe("off");
  });

  test("full-screen call has a named dialog accessible independently from chat history", () => {
    const panel = document.querySelector("#call-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-labelledby")).toBe("call-title");
    for (const action of ["call-answer", "call-decline", "call-end"]) {
      expect(panel.contains(document.getElementById(action))).toBe(true);
    }
  });
});
