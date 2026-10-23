// Independent breadth-first accessibility explorer. The adapter owns the UI runtime.
// No application-specific routes or button lists belong in this module.
export async function explore(adapter, { maxDepth = 4, maxStates = 40, maxActions = 200 } = {}) {
  const queue = [[]];
  const visited = new Set();
  const elements = [];
  const findings = [];
  const actions = [];
  const elementSeen = new Set();
  const findingSeen = new Set();
  let truncated = false;

  async function reach(path) {
    await adapter.reset();
    for (const key of path) {
      const result = await adapter.activate(key);
      if (!result.ok) return { ok: false, reason: result.reason, key };
    }
    return { ok: true };
  }

  while (queue.length) {
    if (visited.size >= maxStates || actions.length >= maxActions) {
      truncated = true;
      break;
    }
    const path = queue.shift();
    const reached = await reach(path);
    if (!reached.ok) {
      findings.push({ severity: "warning", code: "route-unreachable", path, ...reached });
      continue;
    }
    const state = await adapter.inspect();
    if (visited.has(state.signature)) continue;
    visited.add(state.signature);
    const stateName = state.name;
    for (const element of state.elements) {
      const identity = state.signature + "|" + element.key;
      if (!elementSeen.has(identity)) {
        elementSeen.add(identity);
        elements.push({ screen: stateName, path, ...element });
      }
      for (const issue of element.issues ?? []) {
        const k = identity + "|" + issue.code;
        if (!findingSeen.has(k)) {
          findingSeen.add(k);
          findings.push({ screen: stateName, path, element: element.key, source: element.source, ...issue });
        }
      }
    }

    if (path.length >= maxDepth) continue;
    for (const target of state.elements.filter(e => e.action === "navigate")) {
      if (actions.length >= maxActions) { truncated = true; break; }
      const returned = await reach(path);
      if (!returned.ok) continue;
      const before = await adapter.inspect();
      const result = await adapter.activate(target.key);
      const after = await adapter.inspect();
      const changed = before.signature !== after.signature;
      if (result.ok && changed && after.focused?.visible === false) {
        findings.push({ severity: "error", code: "focus-on-hidden-element",
          screen: stateName, element: target.key, source: target.source,
          message: "После перехода фокус остался на скрытом элементе: " + (after.focused.id || "без id") });
      }
      if (result.ok && !changed) {
        findings.push({ severity: "warning", code: "navigation-without-state-change",
          screen: stateName, element: target.key, source: target.source,
          message: "Нажатие элемента навигации не изменило доступный экран." });
      }
      actions.push({
        screen: stateName, path, element: target.key, name: target.name,
        source: target.source, attempted: true, ok: result.ok,
        reason: result.reason ?? null, changed, focus: after.focused,
        result: after.name
      });
      if (!result.ok) {
        findings.push({ severity: "warning", code: "activation-failed",
          screen: stateName, element: target.key, source: target.source, message: result.reason });
      } else if (changed && !visited.has(after.signature)) {
        queue.push([...path, target.key]);
      }
    }
  }
  await adapter.reset();
  return {
    formatVersion: 1, environment: adapter.environment,
    summary: { screens: visited.size, elements: elements.length, inspectedOnly: elements.filter(e => e.action === "inspect-only").length,
      actions: actions.length, errors: findings.filter(f => f.severity === "error").length,
      warnings: findings.filter(f => f.severity === "warning").length,
      truncated, scope: adapter.scope },
    screens: [...visited], elements, findings, actions
  };
}
