import { describe, expect, test } from "vitest";
import { explore } from "../tools/accesspilot/engine.js";
import { createBulbamAdapter } from "../tools/accesspilot/bulbam-adapter.js";

describe("AccessPilot account screens", () => {
  test("follows real registration and recovery buttons without submitting private information", async () => {
    const adapter = await createBulbamAdapter({ mode: "signed-out" });
    try {
      const report = await explore(adapter);
      expect(report.summary.screens).toBe(3);
      expect(report.summary.truncated).toBe(false);
      expect(report.actions.map(a => a.result)).toEqual(expect.arrayContaining([
        "Вход и аккаунт: recovery", "Вход и аккаунт: register", "Вход и аккаунт: login"
      ]));
      expect(report.actions.every(a => a.ok && a.changed)).toBe(true);
      expect(report.actions.find(a => a.name === "Зарегистрироваться")?.source.handlers)
        .toContainEqual(expect.objectContaining({ file: "web/js/auth.js", event: "click" }));
      expect(report.elements.some(item => item.name === "Код приглашения")).toBe(true);
      expect(report.summary.errors).toBe(0);
    } finally { adapter.close(); }
  });
});
