// Visual-only recording feedback. Keep the existing screen-reader labels,
// announcements, keyboard shortcuts and recording logic untouched.
export function renderVoiceRecorderVisual(ui, { recording = false, paused = false, elapsedMs = 0 } = {}) {
  if (ui.recordButton) ui.recordButton.dataset.icon = recording ? "send" : "mic";
  if (ui.panel) ui.panel.hidden = !recording;
  if (ui.body?.classList) ui.body.classList.toggle("voice-recording-paused", recording && paused);
  if (ui.cancelButton) ui.cancelButton.hidden = !recording;
  if (!recording) return;
  if (ui.label) ui.label.textContent = paused ? "Запись на паузе" : "Идёт запись голосового";
  if (ui.timer) {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    ui.timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (ui.hint) ui.hint.textContent = paused
    ? "Голосовое ещё не отправлено. Можно продолжить или отправить."
    : "Голосовое ещё не отправлено. Говорите в микрофон.";
}

export function renderVoiceDeliveryVisual(element, message, state = "progress") {
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || "";
  element.dataset.state = state;
}
