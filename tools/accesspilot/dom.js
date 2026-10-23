// DOM-backed adapter. Accepts a detached/virtual DOM; does not need a visible window.
// Names are approximations from accessibility metadata, NOT verified VoiceOver speech.
const SELECTOR = 'button, input, select, textarea, a[href], summary, [role="button"], [role="switch"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';

function clean(text) { return (text ?? "").replace(/\s+/g, " ").trim(); }
export function isVisible(node, activeDialog = undefined, ignoreAriaHidden = false) {
  // Lookup once per snapshot: doing a full DOM query per element is too costly.
  if (activeDialog === undefined) activeDialog = node.ownerDocument?.querySelector("dialog[open]") ?? null;
  // Native modal dialogs make the rest of the page inert to screen readers.
  if (activeDialog && node !== activeDialog && !activeDialog.contains(node)) return false;
  for (let p = node; p && p.nodeType === 1; p = p.parentElement) {
    if (p.hidden || p.hasAttribute("hidden") || (p.getAttribute("aria-hidden") === "true" && !ignoreAriaHidden)) return false;
    if (p.getAttribute("style")?.match(/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i)) return false;
    if (p.tagName === "DIALOG" && !p.open && !p.hasAttribute("open")) return false;
    if (p.tagName === "DETAILS" && !p.open && p !== node && !p.querySelector("summary")?.contains(node)) return false;
  }
  return node.getAttribute("type") !== "hidden";
}
function contentName(node) {
  return clean([...node.childNodes].map(part => {
    if (part.nodeType === 3) return part.textContent;
    if (part.nodeType === 1 && part.getAttribute("aria-hidden") !== "true") return part.textContent;
    return "";
  }).join(" "));
}
export function accessibleName(node, document) {
  const labelledby = node.getAttribute("aria-labelledby");
  if (labelledby) {
    const value = clean(labelledby.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" "));
    if (value) return { value, origin: "aria-labelledby" };
  }
  if (clean(node.getAttribute("aria-label"))) return { value: clean(node.getAttribute("aria-label")), origin: "aria-label" };
  if (node.id) {
    const label = [...document.querySelectorAll("label[for]")].find(el => el.getAttribute("for") === node.id);
    if (label && clean(label.textContent)) return { value: clean(label.textContent), origin: "label" };
  }
  const parentLabel = node.closest("label");
  if (parentLabel && clean(parentLabel.textContent)) return { value: clean(parentLabel.textContent), origin: "label" };
  const tag = node.tagName.toLowerCase();
  if (["button", "a", "summary"].includes(tag) || node.getAttribute("role") === "button") {
    const inner = contentName(node);
    if (inner) return { value: inner, origin: "content" };
  }
  if (tag === "input" && ["button", "submit", "reset"].includes(node.getAttribute("type"))) {
    if (clean(node.getAttribute("value"))) return { value: clean(node.getAttribute("value")), origin: "value" };
    if (node.getAttribute("type") === "submit") return { value: "Отправить", origin: "default" };
  }
  if (clean(node.getAttribute("title"))) return { value: clean(node.getAttribute("title")), origin: "title" };
  return { value: "", origin: null };
}
function roleOf(node) {
  const role = node.getAttribute("role");
  if (role) return role;
  const tag = node.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag === "input") {
    const type = node.getAttribute("type") ?? "text";
    if (["checkbox", "radio", "range"].includes(type)) return type;
    if (["submit", "button", "reset"].includes(type)) return "button";
    return "textbox";
  }
  return "generic";
}
export function describeElements(document, { locate = () => null, isNavigation = () => false } = {}) {
  const keys = new Map();
  const modal = document.querySelector("dialog[open]");
  // An otherwise active control hidden only via aria-hidden is a real
  // accessibility hazard, not a reason to silently omit it from the report.
  return [...document.querySelectorAll(SELECTOR)]
    .filter(node => isVisible(node, modal, true))
    .map((node, index) => {
    const suppressed = !isVisible(node, modal);
    const role = roleOf(node);
    const name = accessibleName(node, document);
    const source = locate(node);
    const stable = node.id ? "#" + node.id
      : node.dataset?.openSettings ? '[data-open-settings="' + node.dataset.openSettings + '"]'
      : node.dataset?.settingsSubpage ? '[data-settings-subpage="' + node.dataset.settingsSubpage + '"]'
      : node.getAttribute("name") ? node.tagName.toLowerCase() + '[name="' + node.getAttribute("name") + '"]'
      : null;
    // A disambiguated DOM index remains usable for elements without an identifier.
    const ordinal = stable ? (keys.get(stable) ?? 0) : index;
    if (stable) keys.set(stable, ordinal + 1);
    const key = stable ? stable + (ordinal ? ":nth(" + ordinal + ")" : "") : "dom-index:" + index;
    const issues = [];
    if (suppressed) issues.push({
      code: "focusable-hidden-from-screen-reader", severity: "error",
      message: "Интерактивный элемент скрыт от скринридера с помощью aria-hidden."
    });
    if (node.hasAttribute("aria-labelledby")) {
      for (const id of node.getAttribute("aria-labelledby").trim().split(/\s+/)) {
        if (id && !document.getElementById(id)) issues.push({
          code: "broken-labelledby-reference", severity: "error",
          message: "aria-labelledby ссылается на отсутствующий элемент: " + id
        });
      }
    }
    const tabindex = Number(node.getAttribute("tabindex") ?? 0);
    if (tabindex > 0) issues.push({
      code: "positive-tabindex", severity: "warning",
      message: "Положительный tabindex нарушает естественный порядок клавиатурного обхода."
    });
    if (node.getAttribute("role") === "button" && node.tagName.toLowerCase() !== "button"
        && !node.hasAttribute("tabindex")) issues.push({
      code: "custom-button-not-focusable", severity: "error",
      message: "Нестандартная кнопка не включена в клавиатурную навигацию."
    });
    if (!name.value && role !== "generic") issues.push({
      code: "missing-accessible-name", severity: "error",
      message: "Элемент не имеет определяемого доступного названия."
    });
    if (!name.value && clean(node.getAttribute("placeholder")) && ["textbox", "combobox"].includes(role)) {
      issues.push({ code: "placeholder-is-not-label", severity: "warning",
        message: "Подсказка в поле ввода не заменяет доступного названия." });
    }
    const state = suppressed ? "aria-hidden" : node.disabled ? "disabled" : node.getAttribute("aria-pressed") !== null
      ? "pressed=" + node.getAttribute("aria-pressed") : node.getAttribute("aria-expanded") !== null
      ? "expanded=" + node.getAttribute("aria-expanded") : node.getAttribute("aria-checked") !== null
      ? "checked=" + node.getAttribute("aria-checked") : "enabled";
    const russianRole = { button: "кнопка", link: "ссылка", checkbox: "флажок",
      radio: "переключатель", switch: "переключатель", textbox: "поле ввода",
      combobox: "список", generic: "элемент", range: "ползунок" }[role] ?? role;
    const russianState = state === "disabled" ? "недоступно" : state === "enabled" ? ""
      : state.replace("pressed=", "нажата: ").replace("expanded=", "раскрыта: ").replace("checked=", "отмечена: ");
    return { key, index, role, name: name.value, nameOrigin: name.origin,
      predictedAnnouncement: clean([name.value || "(без названия)", russianRole, russianState].filter(Boolean).join(", ")),
      state, source, action: !suppressed && isNavigation(node) ? "navigate" : "inspect-only", issues };
  });
}
export function findControl(document, key) {
  const modal = document.querySelector("dialog[open]");
  if (key.startsWith("dom-index:")) return [...document.querySelectorAll(SELECTOR)].filter(node => isVisible(node, modal))[Number(key.slice(10))] ?? null;
  const hit = key.match(/^(.*?):nth\((\d+)\)$/);
  const selector = hit ? hit[1] : key;
  try {
    const options = [...document.querySelectorAll(selector)].filter(node => isVisible(node, modal));
    return options[hit ? Number(hit[2]) : 0] ?? null;
  } catch { return null; }
}
