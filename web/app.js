const workerStatus = document.querySelector("#worker-status");
const liveStatus = document.querySelector("#live-status");
const checkButton = document.querySelector("#check-server");

async function checkServer() {
  checkButton.disabled = true;
  workerStatus.textContent = "проверяется…";
  liveStatus.textContent = "Проверяю связь с сервером.";

  try {
    const response = await fetch("/api/health", {
      headers: { accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const health = await response.json();
    if (health.ok !== true) {
      throw new Error("Worker вернул некорректный ответ");
    }

    workerStatus.textContent = "работает";
    liveStatus.textContent = `Связь есть. Сервер ${health.service}, версия ${health.version}.`;
  } catch (error) {
    workerStatus.textContent = "нет связи";
    liveStatus.textContent = `Не удалось связаться с сервером: ${error.message}`;
  } finally {
    checkButton.disabled = false;
  }
}

checkButton.addEventListener("click", checkServer);
checkServer();
