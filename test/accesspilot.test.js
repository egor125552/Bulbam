import { describe, test, expect } from "vitest";
import { parseHTML } from "linkedom";
import { describeElements, isVisible } from "../tools/accesspilot/dom.js";
import { explore } from "../tools/accesspilot/engine.js";

describe("AccessPilot autonomous test engine", () => {
  test("identifies unnamed controls and reports exact source supplied by adapter", () => {
    const { document } = parseHTML('<html><body><button id="blank" aria-label=""></button><label for="named">Поиск</label><input id="named"><div hidden><button id="hidden"></button></div></body></html>');
    const results = describeElements(document, { locate: () => ({ file: "form.js", line: 23 }) });
    expect(results.map(e => e.key)).toEqual(["#blank", "#named"]);
    expect(results[0].issues.map(issue => issue.code)).toContain("missing-accessible-name");
    expect(results[0].source).toEqual({ file: "form.js", line: 23 });
    expect(results[1].name).toBe("Поиск");
    expect(results[1].issues).toHaveLength(0);
  });

  test("respects native modal semantics, even without a visible browser window", () => {
    const { document } = parseHTML('<html><body><button id="outside">Главная</button><dialog open><button id="inside">Внутри</button></dialog></body></html>');
    expect(isVisible(document.getElementById("outside"))).toBe(false);
    expect(isVisible(document.getElementById("inside"))).toBe(true);
  });

  test("automatically discovers nested navigation without a scripted route", async () => {
    let state = "root";
    const tree = {
      root: [{ key: "open", name: "Открыть", action: "navigate", issues: [] }],
      inner: [{ key: "deeper", name: "Далее", action: "navigate", issues: [] },
        { key: "delete", name: "Удалить", action: "inspect-only", issues: [] }],
      deep: [{ key: "back", name: "Назад", action: "inspect-only", issues: [{
        code: "missing-accessible-name", severity: "error", message: "Пустое название"
      }] }]
    };
    const adapter = {
      environment: "fake",
      scope: "fake",
      reset: async () => { state = "root"; },
      inspect: async () => ({ name: state, signature: state, elements: tree[state] }),
      activate: async key => {
        state = key === "open" ? "inner" : "deep";
        return { ok: true };
      }
    };
    const report = await explore(adapter);
    expect(report.summary.screens).toBe(3);
    expect(report.actions.map(a => a.element)).toEqual(["open", "deeper"]);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "missing-accessible-name" }));
    expect(report.elements.find(e => e.key === "delete").action).toBe("inspect-only");
    expect(report.summary.truncated).toBe(false);
  });

  test("enforces limits to avoid loops and runaway investigation", async () => {
    let depth = 0;
    const adapter = {
      environment: "fake", scope: "fake",
      reset: async () => { depth = 0; },
      inspect: async () => ({
        signature: String(depth), name: "level" + depth,
        elements: [{ key: "next", name: "Следующий", action: "navigate", issues: [] }]
      }),
      activate: async () => { depth++; return { ok: true }; }
    };
    const report = await explore(adapter, { maxDepth: 10, maxStates: 2, maxActions: 100 });
    expect(report.summary.screens).toBe(2);
    expect(report.summary.truncated).toBe(true);
  });
});
