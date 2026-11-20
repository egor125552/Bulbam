// Text messages should be read by VoiceOver only once through their native
// visible content; voice messages already contain their own labelled player.
export function applyMessageScreenReaderSemantics(root) {
  for (const item of root.querySelectorAll('.message')) {
    item.removeAttribute('role');
    item.removeAttribute('aria-label');
  }
}
