export const MESSAGE_VIEWS = ["bubbles", "compact", "table"];
export const THEMES = ["system", "dark", "light"];
export const FONT_SCALES = ["small", "medium", "large"];

export function normalizeMessageView(value) {
  return MESSAGE_VIEWS.includes(value) ? value : "bubbles";
}

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : "system";
}

export function normalizeFontScale(value) {
  return FONT_SCALES.includes(value) ? value : "medium";
}
