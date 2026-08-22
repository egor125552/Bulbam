export function callPanelHasActiveControls(buttons) {
  return buttons.some((button) => button && !button.hidden);
}

export function setupFinishedCallPanelCleanup() {
  const panel = document.querySelector("#call-panel");
  if (!panel || !window.MutationObserver) return;

  const buttons = [
    document.querySelector("#call-answer"),
    document.querySelector("#call-decline"),
    document.querySelector("#call-resume"),
    document.querySelector("#call-mute"),
    document.querySelector("#call-end")
  ];

  let scheduled = false;
  const reconcile = () => {
    scheduled = false;
    if (panel.hidden || callPanelHasActiveControls(buttons)) return;

    // calls.js leaves the banner visible after renderFinished() so the final
    // status can be announced. Voice recording used banner visibility as a
    // proxy for an active call, so that informational banner blocked the mic.
    // Once no call action remains, the banner represents a terminal state.
    panel.hidden = true;
  };

  const scheduleReconcile = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(reconcile);
  };

  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  for (const button of buttons) {
    if (button) observer.observe(button, { attributes: true, attributeFilter: ["hidden"] });
  }

  scheduleReconcile();
}
