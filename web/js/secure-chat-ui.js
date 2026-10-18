import { generateConversationSecret, loadConversationKey, saveConversationKey } from "./secure-messages.js";

let selectedAccountId = null;
let selectedConversationId = null;
let encryptionKey = null;
let keyIsLoading = false;
let loadFailed = false;
let updateMessages = null;
let requestSerial = 0;
let lastGeneratedSecret = "";

const element = (id) => document.getElementById(id);

function setStatus(value) {
  const output = element("secure-chat-status");
  if (output) output.textContent = value;
}

function updatePresentation() {
  const hasChat = Boolean(selectedAccountId && selectedConversationId);
  const active = Boolean(encryptionKey && !keyIsLoading && !loadFailed);
  const open = element("secure-chat-open");
  const label = element("secure-chat-label");
  if (open) open.hidden = !hasChat;
  if (label) {
    label.hidden = !hasChat;
    label.textContent = active ? "Экспериментальная защита новых текстовых сообщений включена" :
      keyIsLoading || loadFailed ? "Защита недоступна. Отправка временно остановлена" :
        "Обычные сообщения. Без сквозного шифрования";
  }
  const onboarding = element("secure-chat-onboarding");
  if (onboarding) onboarding.hidden = !hasChat || Boolean(encryptionKey) || keyIsLoading || loadFailed;
  const recording = document.querySelector("#voice-record-button");
  const draftSend = element("voice-draft-send");
  if (recording) {
    recording.disabled = active;
    recording.title = active ? "Голосовые пока не защищены" : "";
  }
  if (draftSend) draftSend.disabled = active;
  if (!hasChat) setStatus("Откройте переписку.");
  else if (keyIsLoading) setStatus("Проверяю наличие ключа на этом устройстве.");
  else if (loadFailed) setStatus("Не удалось проверить сохранённые ключи. Обычная отправка отключена во избежание ошибки.");
  else if (active) setStatus("Новые текстовые сообщения шифруются на этом устройстве. Ключ хранится только здесь. Голосовые отключены.");
  else setStatus("Защита выключена. Создайте новый ключ или введите ключ собеседника.");
}

export function getSecureChatState() {
  return {
    accountId: selectedAccountId,
    conversationId: selectedConversationId,
    key: encryptionKey,
    blocked: keyIsLoading || loadFailed
  };
}

export async function setSecureConversation(account, chat) {
  const serial = ++requestSerial;
  selectedAccountId = account?.userId ?? null;
  selectedConversationId = chat?.conversationId ?? null;
  encryptionKey = null;
  keyIsLoading = Boolean(selectedAccountId && selectedConversationId);
  loadFailed = false;
  clearGeneratedSecret();
  updatePresentation();
  if (!keyIsLoading) return;
  const accountId = selectedAccountId;
  const conversationId = selectedConversationId;
  try {
    const found = await loadConversationKey(accountId, conversationId);
    if (serial !== requestSerial) return;
    encryptionKey = found;
  } catch {
    if (serial !== requestSerial) return;
    loadFailed = true;
  } finally {
    if (serial === requestSerial) {
      keyIsLoading = false;
      updatePresentation();
      updateMessages?.();
    }
  }
}

function clearGeneratedSecret() {
  lastGeneratedSecret = "";
  const output = element("secure-chat-key-output");
  if (output) output.value = "";
  const exported = element("secure-chat-export");
  if (exported) exported.hidden = true;
}

export function setupSecureChat({ onKeyChanged } = {}) {
  updateMessages = onKeyChanged ?? null;
  const dialog = element("secure-chat-dialog");
  element("secure-chat-open")?.addEventListener("click", () => {
    updatePresentation();
    dialog?.showModal();
    element("secure-chat-title")?.focus();
  });
  element("secure-chat-close")?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("close", () => {
    clearGeneratedSecret();
    const input = element("secure-chat-key-input");
    if (input) input.value = "";
    element("secure-chat-open")?.focus();
  });
  element("secure-chat-generate")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (encryptionKey || keyIsLoading || loadFailed || !selectedConversationId) return;
    if (document.querySelector("#voice-record-button")?.getAttribute("aria-pressed") === "true") {
      setStatus("Сначала завершите или отмените текущую запись голосового.");
      return;
    }
    const accountId = selectedAccountId;
    const conversationId = selectedConversationId;
    const serial = requestSerial;
    button.disabled = true;
    try {
      const secret = generateConversationSecret();
      const key = await saveConversationKey(accountId, conversationId, secret);
      if (serial !== requestSerial) return;
      encryptionKey = key;
      lastGeneratedSecret = secret;
      const output = element("secure-chat-key-output");
      output.value = secret;
      element("secure-chat-export").hidden = false;
      updatePresentation();
      setStatus("Защита включена. Скопируйте ключ сейчас и передайте собеседнику по другому надёжному каналу.");
      updateMessages?.();
      output.focus();
    } catch (error) {
      setStatus("Не удалось создать ключ: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
  element("secure-chat-save")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (encryptionKey || keyIsLoading || loadFailed || !selectedConversationId) return;
    if (document.querySelector("#voice-record-button")?.getAttribute("aria-pressed") === "true") {
      setStatus("Сначала завершите или отмените текущую запись голосового.");
      return;
    }
    const accountId = selectedAccountId;
    const conversationId = selectedConversationId;
    const serial = requestSerial;
    button.disabled = true;
    try {
      const input = element("secure-chat-key-input");
      const key = await saveConversationKey(accountId, conversationId, input.value);
      input.value = "";
      if (serial !== requestSerial) return;
      encryptionKey = key;
      updatePresentation();
      setStatus("Ключ сохранён на этом устройстве. Можно читать и отправлять новые защищённые текстовые сообщения.");
      updateMessages?.();
    } catch (error) {
      setStatus("Ключ не принят: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
  element("secure-chat-copy")?.addEventListener("click", async () => {
    if (!lastGeneratedSecret) return;
    try {
      await navigator.clipboard.writeText(lastGeneratedSecret);
      setStatus("Ключ скопирован. Отправьте его через другой надёжный канал, не через Бульбам.");
    } catch {
      setStatus("Копирование не удалось. Выделите ключ в поле и скопируйте вручную.");
      element("secure-chat-key-output")?.focus();
      element("secure-chat-key-output")?.select();
    }
  });
}
