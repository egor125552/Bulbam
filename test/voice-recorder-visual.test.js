import { describe, expect, test } from "vitest";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { renderVoiceRecorderVisual } from "../web/js/voice-recorder-visual.js";

const html = readFileSync(new URL("../web/index.html",import.meta.url),"utf8");
const css = readFileSync(new URL("../web/styles.css",import.meta.url),"utf8");
const canonical = readFileSync(new URL("../web/canonical-ui.css",import.meta.url),"utf8");
function controls() {
  const {document} = parseHTML(html);
  return {
    panel: document.querySelector("#voice-recording-panel"),
    label: document.querySelector("#voice-recording-visual-label"),
    timer: document.querySelector("#voice-recording-visual-timer"),
    hint: document.querySelector("#voice-recording-visual-hint"),
    cancelButton: document.querySelector("#voice-cancel-button"),
    recordButton: document.querySelector("#voice-record-button")
  };
}

describe("sighted voice message controls without changing screen-reader behavior", () => {
  test("visible record controls make recording, pause, cancel and send unambiguous", () => {
    const ui = controls();
    expect(ui.panel).toBeTruthy();
    expect(ui.panel.hasAttribute("aria-hidden") && ui.panel.getAttribute("aria-hidden")).toBe("true");
    expect(ui.cancelButton.hidden).toBe(true);
    const originalRecordLabel = ui.recordButton.getAttribute("aria-label");
    renderVoiceRecorderVisual(ui, {recording:true,paused:false,elapsedMs:8500});
    expect(ui.panel.hidden).toBe(false);
    expect(ui.cancelButton.hidden).toBe(false);
    expect(ui.label.textContent).toContain("Идёт запись");
    expect(ui.timer.textContent).toBe("0:08");
    expect(ui.recordButton.dataset.icon).toBe("send");
    expect(ui.recordButton.getAttribute("aria-label")).toBe(originalRecordLabel);
    renderVoiceRecorderVisual(ui, {recording:true,paused:true,elapsedMs:8500});
    expect(ui.label.textContent).toContain("паузе");
    expect(ui.timer.textContent).toBe("0:08");
    expect(ui.hint.textContent).toContain("ещё не отправлено");
    renderVoiceRecorderVisual(ui, {recording:false});
    expect(ui.panel.hidden).toBe(true);
    expect(ui.cancelButton.hidden).toBe(true);
    expect(ui.recordButton.dataset.icon).toBe("mic");
  });
  test("existing VoiceOver control IDs, button names, timers and keyboard help are unchanged", () => {
    const ui = controls();
    expect(ui.recordButton.getAttribute("aria-label")).toBe("Записать голосовое");
    expect(ui.recordButton.getAttribute("aria-describedby")).toBe("voice-record-hint");
    expect(html).toContain('id="voice-pause-button"');
    expect(html).toContain('id="voice-recording-status"');
    expect(html).toContain('Escape отменяет запись. На Mac можно удерживать Option.');
    expect(ui.cancelButton.getAttribute("type")).toBe("button");
    expect(ui.cancelButton.getAttribute("aria-label")).toBe("Отменить запись голосового");
  });
  test("clear visible labels and safe mobile layouts, with reduced-motion handling", () => {
    expect(css).toContain('.voice-recording-panel');
    expect(css).toContain('.voice-recording .composer > #voice-record-button');
    expect(css).toContain('#voice-cancel-button');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(canonical).toContain('.voice-recording .voice-action');
  });
});

test("visual post-recording confirmation and delivery status stay out of VoiceOver", async () => {
  const {renderVoiceDeliveryVisual} = await import("../web/js/voice-recorder-visual.js");
  const {document} = parseHTML(html);
  const visual = document.querySelector("#voice-delivery-visual");
  expect(visual.getAttribute("aria-hidden")).toBe("true");
  expect(visual.hidden).toBe(true);
  renderVoiceDeliveryVisual(visual,"Отправляю голосовое…");
  expect(visual.hidden).toBe(false);
  expect(visual.dataset.state).toBe("progress");
  renderVoiceDeliveryVisual(visual,"Отправлено.","success");
  expect(visual.dataset.state).toBe("success");
  renderVoiceDeliveryVisual(visual,"");
  expect(visual.hidden).toBe(true);
});
