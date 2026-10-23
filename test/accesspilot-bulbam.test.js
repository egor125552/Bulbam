import { describe, expect, test } from "vitest";
import { explore } from "../tools/accesspilot/engine.js";
import { createBulbamAdapter } from "../tools/accesspilot/bulbam-adapter.js";

describe("Bulbam virtual accessibility integration", () => {
  test("walks actual settings button handlers, including nested pages, offline", async () => {
    const adapter = await createBulbamAdapter();
    try {
      const report = await explore(adapter);
      expect(report.summary.truncated).toBe(false);
      expect(report.summary.screens).toBeGreaterThanOrEqual(12);
      expect(report.actions).toContainEqual(expect.objectContaining({
        name: "Изменить пароль", ok: true, changed: true,
        result: "Настройки: Смена пароля"
      }));
      expect(report.actions).toContainEqual(expect.objectContaining({
        name: "Микрофон и качество звука", ok: true, changed: true
      }));
      const generated = report.elements.find(item => item.key === '[data-open-settings="general"]');
      expect(generated?.source.generated).toEqual(expect.objectContaining({
        file: "web/js/settings-screens.js"
      }));
      expect(generated?.source.handlers).toContainEqual(expect.objectContaining({
        event: "click", file: "web/js/settings-screens.js"
      }));
      expect(report.summary.inspectedOnly).toBeGreaterThan(15);
      const toggles = report.actions.filter(item => item.element === "#new-chat-button");
      expect(toggles).toContainEqual(expect.objectContaining({
        screen: "Главный экран: новый чат",
        focus: expect.objectContaining({ id: "new-chat-button", visible: true })
      }));
      expect(report.findings.filter(item => item.code === "focus-on-hidden-element")).toEqual([]);
    } finally {
      adapter.close();
    }
  });
});
