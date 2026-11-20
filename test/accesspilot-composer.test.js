import { describe, expect, test } from "vitest";
import { explore } from "../tools/accesspilot/engine.js";
import { createBulbamAdapter } from "../tools/accesspilot/bulbam-adapter.js";

describe("AccessPilot synthetic composer state", () => {
  test("inspects composer labels without transmitting messages", async () => {
    const adapter = await createBulbamAdapter({ mode: "composer" });
    try {
      const report = await explore(adapter);
      const input = report.elements.find(item => item.key === "#message-input");
      expect(input).toEqual(expect.objectContaining({
        name: "Сообщение", action: "inspect-only", role: "textbox"
      }));
      expect(report.actions.every(item => !["Отправить сообщение", "Завершить звонок", "Удалить"].includes(item.name))).toBe(true);
      expect(report.findings.filter(f => f.code === "focus-on-hidden-element")).toEqual([]);
    } finally { adapter.close(); }
  });
});
