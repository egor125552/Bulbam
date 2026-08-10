import { api } from "./api.js";
import { announce, elements } from "./ui.js";

export function setupInvites() {
  elements.inviteForm.addEventListener("submit", createInvite);
}

async function createInvite(event) {
  event.preventDefault();
  const button = elements.inviteForm.querySelector("button[type=submit]");
  button.disabled = true;
  const data = new FormData(elements.inviteForm);
  const expiresInHours = Number(data.get("expiresInHours"));
  elements.newInvite.hidden = true;
  announce("Создаю одноразовое приглашение.");

  try {
    const result = await api("/api/v1/invites", {
      method: "POST",
      body: JSON.stringify({ expiresInHours })
    });
    elements.newInviteCode.textContent = result.code;
    elements.newInvite.hidden = false;
    announce("Приглашение создано. Скопируй код: сервер хранит только его хэш.");
  } catch (error) {
    announce(`Не удалось создать приглашение: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}
