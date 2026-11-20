import { logDiagnostic, diagnosticText, clearDiagnostics, subscribeDiagnostics, diagnosticErrorName, diagnosticErrorOrigin, diagnosticStats } from "./diagnostics-log.js";

const IGNORE = /password|secret|token|recovery|code|passkey|key|username|message|text|search|invite|profile|auth/i;
function eventTargetId(node) {
  const element = node?.closest?.("button, select, summary, a");
  if (!element || element.closest?.("[data-diagnostics-private]")) return null;
  const id = element.id || element.dataset?.openSettings || element.dataset?.settingsSubpage || "";
  if (!/^[a-z][a-z0-9-]{1,60}$/i.test(id) || IGNORE.test(id)) return null;
  return id;
}
export function setupDiagnostics() {
  const field = document.querySelector("#diagnostics-log");
  const status = document.querySelector("#diagnostics-log-status");
  if (!field) return;
  const dialog = document.querySelector("#settings-dialog");
  let updateScheduled = false;
  const updateField = () => {
    field.value = diagnosticText();
    const stats=diagnosticStats();
    const count=document.querySelector('#diagnostics-count');
    if(count)count.textContent=`Событий: ${stats.count} из ${stats.limit}. Всего за сеанс: ${stats.total}.`;
  };
  updateField();
  // Keeping a 900-line textarea synchronized after every polling request
  // would slow down ordinary calls. Only render while diagnostics is open.
  subscribeDiagnostics(() => {
    if (!dialog?.open || updateScheduled) return;
    updateScheduled = true;
    setTimeout(() => { updateScheduled = false; if (dialog.open) updateField(); }, 200);
  });
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-open-settings='diagnostics']");
    if (button) setTimeout(updateField, 0);
  }, true);
  document.addEventListener("click", (event) => {
    const id = eventTargetId(event.target);
    if (id) logDiagnostic("Интерфейс", `кнопка ${id}`);
  }, true);
  document.addEventListener("change", (event) => {
    const id = eventTargetId(event.target);
    if (id) logDiagnostic("Интерфейс", `изменение ${id}`);
  }, true);
  window.addEventListener("online", () => logDiagnostic("Сеть", "интернет появился"));
  window.addEventListener("offline", () => logDiagnostic("Сеть", "интернет пропал"));
  document.addEventListener("visibilitychange", () => logDiagnostic("Навигация", document.visibilityState === "visible" ? "страница открыта" : "страница скрыта"));
  window.addEventListener("error", (event) =>
    logDiagnostic("Ошибки", "ошибка выполнения JavaScript", diagnosticErrorName(event.error)));
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    logDiagnostic("Ошибки", "необработанная ошибка Promise", diagnosticErrorName(reason));
    const source = diagnosticErrorOrigin(reason);
    if (source !== "unknown") logDiagnostic("Ошибки", "источник Promise", source);
  });
  document.querySelector("#diagnostics-clear")?.addEventListener("click", () => {
    clearDiagnostics();
    if (status) status.textContent = "Журнал очищен.";
  });
  document.querySelector("#diagnostics-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diagnosticText());
      if (status) status.textContent = "Журнал скопирован.";
    } catch {
      field.focus(); field.select();
      if (status) status.textContent = "Журнал выделен. Скопируйте его стандартной командой.";
    }
  });
  document.querySelector("#diagnostics-download")?.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([diagnosticText()], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bulbam-diagnostics-${new Date().toISOString().slice(0,10)}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoke on a later task, after Safari has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (status) status.textContent = "Скачивание журнала начато.";
  });
  logDiagnostic("Навигация", "диагностика запущена");
}
