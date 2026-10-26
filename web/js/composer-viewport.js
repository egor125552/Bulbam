// On iPhone Safari the software keyboard shrinks visualViewport, not
// necessarily 100dvh. Keeping the whole app at 100dvh with body overflow
// hidden puts the message box behind the keyboard and prevents Safari from
// scrolling it into view. Only adjust the chat while the composer is focused.
export function setupComposerViewport({ document: doc = document, window: win = window } = {}) {
  const field = doc.querySelector("#message-input");
  const viewport = win.visualViewport;
  if (!field || !viewport?.addEventListener) return () => {};
  const root = doc.documentElement;
  let editing = doc.activeElement === field;
  const property = "--bulbam-usable-height";
  const update = () => {
    if (!editing) {
      root.style.removeProperty(property);
      return;
    }
    const height = Number(viewport.height);
    if (!Number.isFinite(height) || height < 160) return;
    const value = Math.round(height) + "px";
    if (root.style.getPropertyValue(property) !== value)
      root.style.setProperty(property, value);
  };
  // Let iOS finish focusing the textarea and opening its keyboard before
  // changing layout. A synchronous CSS height write during focus can disrupt
  // VoiceOver's activation in a nested scroll/grid layout.
  const focus = () => { editing = true; };
  const blur = () => { editing = false; update(); };
  field.addEventListener("focus", focus);
  field.addEventListener("blur", blur);
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  // No geometry writes on initial setup or during the focus event.
  return () => {
    field.removeEventListener("focus", focus);
    field.removeEventListener("blur", blur);
    viewport.removeEventListener?.("resize", update);
    viewport.removeEventListener?.("scroll", update);
    root.style.removeProperty(property);
  };
}
