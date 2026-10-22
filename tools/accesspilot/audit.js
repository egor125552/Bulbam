import axe from "axe-core";

// Cross-application WCAG audit of the actual DOM rendered by Chromium.
// Every finding keeps the concrete selector and rule that detected it.
export async function installAccessibilityAudit(context) {
  await context.addInitScript({ content: axe.source });
}

export async function auditAccessibility(page) {
  return page.evaluate(async () => {
    if (!window.axe) return [{ code: "audit-unavailable", message: "axe-core did not initialize" }];
    const report = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } }
    });
    return report.violations.flatMap(rule => rule.nodes.map(node => ({
      code: "wcag-" + rule.id,
      severity: rule.impact || "unknown",
      message: rule.help,
      selector: node.target.join(", "),
      summary: node.failureSummary || "",
      guideline: rule.helpUrl
    })));
  });
}
