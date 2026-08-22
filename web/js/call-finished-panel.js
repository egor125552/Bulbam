export function callPanelHasActiveControls(buttons) {
  return buttons.some((button) => button && !button.hidden);
}

export function releaseFinishedCallPanel(panel, buttons) {
  if (!panel || panel.hidden || callPanelHasActiveControls(buttons)) return false;
  panel.hidden = true;
  return true;
}

export function setupFinishedCallPanelCleanup() {
  const panel = document.querySelector("#call-panel");
  const recordButton = document.querySelector("#voice-record-button");
  if (!panel || !recordButton) return;

  const buttons = [
    document.querySelector("#call-answer"),
    document.querySelector("#call-decline"),
    document.querySelector("#call-resume"),
    document.querySelector("#call-mute"),
    document.querySelector("#call-end")
  ];

  const releaseIfFinished = () => releaseFinishedCallPanel(panel, buttons);

  // calls.js intentionally keeps the final call result visible. Keep that
  // accessible feedback until the user actually asks to record a voice
  // message, then remove only a terminal banner before voice-recorder.js
  // checks panel visibility. Capture phase makes this happen first.
  recordButton.addEventListener("click", releaseIfFinished, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Alt") releaseIfFinished();
  }, true);
}
