import { api } from "./api.js";
import { announce, elements } from "./ui.js";

export function setupHealth() {
  elements.checkButton.addEventListener("click", checkServer);
}

export async function checkServer() {
  elements.checkButton.disabled = true;
  elements.workerStatus.textContent = "проверяется…";
  elements.storageStatus.textContent = "проверяется…";
  announce("Проверяю Worker и постоянное хранилище.");

  try {
    const health = await api("/api/health");
    elements.workerStatus.textContent = health.ok ? `работает · ${health.version}` : "ошибка";

    if (health.storage?.binding === "missing") {
      elements.storageStatus.textContent = "D1 не подключена";
      announce("Worker работает, но binding D1 не подключён. Нужен DB binding в Cloudflare.");
      return;
    }
  } catch (error) {
    elements.workerStatus.textContent = "нет связи";
    elements.storageStatus.textContent = "не проверено";
    announce(`Worker недоступен: ${error.message}`);
    elements.checkButton.disabled = false;
    return;
  }

  try {
    await api("/api/ready");
    elements.storageStatus.textContent = "готово";
    announce("Worker и постоянное хранилище работают.");
  } catch (error) {
    if (error.code === "storage_binding_missing") {
      elements.storageStatus.textContent = "D1 не подключена";
    } else if (error.code === "storage_initialization_failed") {
      elements.storageStatus.textContent = "ошибка инициализации D1";
    } else {
      elements.storageStatus.textContent = "ошибка";
    }
    announce(`Worker работает, но хранилище не готово: ${error.message}`);
  } finally {
    elements.checkButton.disabled = false;
  }
}
