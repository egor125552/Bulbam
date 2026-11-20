// Независимый модуль восстановления: список кодов не отправляется по сети.
const CODE_RE = /(^|[^a-z0-9_])BRC-[0-9a-f]{6}(?:-[0-9a-f]{6}){3}(?![a-z0-9_-])/gi;

export function extractRecoveryCodes(value) {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—―−]/g, "-");
  const codes = [];
  for (const match of text.matchAll(CODE_RE))
    codes.push(match[0].slice(match[1].length).toUpperCase());
  return codes;
}

export function firstRecoveryCode(value) {
  return extractRecoveryCodes(value)[0] ?? null;
}

const MANY_STATUS = "Из списка выбран первый резервный код. Остальные не отправлены на сервер. После успешного восстановления весь старый набор перестанет действовать.";
const ONE_STATUS = "Из вставленного текста выделен один резервный код.";

export function setupRecoveryCodeSmartPaste(input, feedback) {
  if (!input || !feedback) return () => {};

  function apply(value, pasted) {
    const codes = extractRecoveryCodes(value);
    if (!codes.length) return false;
    const first = codes[0];
    const normal = String(value).trim().toUpperCase() === first;
    if (!pasted && normal) return false;
    input.value = first;
    feedback.textContent = codes.length > 1 ? MANY_STATUS : (!normal ? ONE_STATUS : "");
    return true;
  }

  function onPaste(event) {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return; // Safari может не предоставить буфер событию.
    if (apply(text, true)) event.preventDefault();
  }

  function onInput(event) {
    if (event.isComposing) return;
    if (!apply(input.value, false)) feedback.textContent = "";
  }

  input.addEventListener("paste", onPaste);
  input.addEventListener("input", onInput);
  return () => {
    input.removeEventListener("paste", onPaste);
    input.removeEventListener("input", onInput);
  };
}
