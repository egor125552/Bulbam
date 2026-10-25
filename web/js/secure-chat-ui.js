import { generateConversationSecret, loadConversationKey, saveConversationKey, forgetConversationKey } from "./secure-messages.js";
import { api } from "./api.js";
import { deriveAutoChatKey, registerIdentity, existingIdentity } from './auto-keys.js';

let selectedAccountId = null;
let selectedConversationId = null;
let encryptionKey = null;
let keyIsLoading = false;
let loadFailed = false;
let protectedHistorySeen = false;
let serverProtected = false;
let automaticMode = false;
let waitingPeer = false;
let autoError = '';
let currentPeerId = null;
let autoOptedIn = false;
let groupConversation = false;
let activationFailed = false;
let updateMessages = null;
let requestSerial = 0;
let lastGeneratedSecret = "";

const element = (id) => document.getElementById(id);

function setStatus(value) {
  const output = element("secure-chat-status");
  if (output) output.textContent = value;
}

function updatePresentation() {
  const hasChat = Boolean(selectedAccountId && selectedConversationId && !groupConversation);
  const active = Boolean(serverProtected && encryptionKey && !keyIsLoading && !loadFailed);
  const autoPending=Boolean(currentPeerId && (autoOptedIn || automaticMode) && !encryptionKey && !serverProtected);
  const open = element("secure-chat-open");
  const label = element("secure-chat-label");
  if (open) open.hidden = !hasChat;
  if (label) {
    label.hidden = !hasChat;
    label.textContent = active && automaticMode ? "Автоматическая защита сообщений и голосовых включена" :
      active ? "Новые текстовые и голосовые сообщения защищены (эксперимент)" :
      autoPending ? "Ожидаю автоматический обмен ключами. Отправка заблокирована" :
      keyIsLoading || loadFailed || Boolean(encryptionKey && !serverProtected) ? "Защита не готова. Отправка остановлена" :
        serverProtected || protectedHistorySeen ? "Защищённый чат: для отправки нужен ключ" :
        "Обычные сообщения. Без сквозного шифрования";
  }
  const manualHint=element('secure-chat-manual-hint');
  if(manualHint)manualHint.hidden=automaticMode || autoPending || (!serverProtected && autoOptedIn);
  const onboarding = element("secure-chat-onboarding");
  if (onboarding) onboarding.hidden = !hasChat || automaticMode || autoPending || Boolean(encryptionKey) || keyIsLoading || loadFailed;
  const generate = element("secure-chat-generate");
  if (generate) generate.hidden = serverProtected || protectedHistorySeen || autoPending;
  const forget = element('secure-chat-forget');
  if(forget) forget.hidden=!hasChat || !encryptionKey || automaticMode;
  const activate = element("secure-chat-activate");
  if (activate) activate.hidden = !hasChat || !encryptionKey || serverProtected || automaticMode;
  const enroll=element('secure-chat-enroll-auto');
  if(enroll)enroll.hidden=!hasChat || Boolean(encryptionKey) || serverProtected || autoOptedIn || keyIsLoading;
  const retry=element('secure-chat-retry-auto');
  if(retry)retry.hidden=!hasChat || !currentPeerId || (!autoOptedIn && !automaticMode) || Boolean(encryptionKey) || (!waitingPeer && !loadFailed && !autoPending);
  const recording = document.querySelector("#voice-record-button");
  const draftSend = element("voice-draft-send");
  if (recording) {
    recording.disabled = keyIsLoading || loadFailed || autoPending || Boolean(encryptionKey && !serverProtected) || (serverProtected && !encryptionKey);
    recording.title = active ? "Запись защищённого голосового сообщения" : "";
  }
  if (draftSend) draftSend.disabled = keyIsLoading || loadFailed || autoPending || Boolean(encryptionKey && !serverProtected) || (serverProtected && !encryptionKey);
  if (!hasChat) setStatus("Откройте переписку.");
  else if (keyIsLoading) setStatus("Проверяю и автоматически согласовываю ключи с собеседником.");
  else if (loadFailed) setStatus(autoError || "Не удалось проверить ключи. Открытая отправка отключена.");
  else if (waitingPeer) setStatus("Жду, когда собеседник откроет обновлённый Бульбам и зарегистрирует ключ. Открытая отправка заблокирована. Нажмите «Повторить автоматический обмен» для проверки.");
  else if (active && automaticMode) setStatus("Ключ согласован автоматически через ECDH. Сервер не знает общего секрета. На новых устройствах аккаунта потребуется отдельное безопасное подключение.");
  else if (active) setStatus("Новые текстовые и голосовые сообщения шифруются на этом устройстве. Ключ сохраняется локально; передайте его через надёжный независимый канал.");
  else if(encryptionKey && !serverProtected) setStatus("Ключ есть на устройстве, но сервер ещё не подтвердил защиту чата. Нажмите «Включить защиту чата».");
  else if (serverProtected || protectedHistorySeen) setStatus("Защищённый диалог. Введите проверенный ключ через другой канал. Открытая отправка заблокирована.");
  else setStatus("Защита выключена. Создайте новый ключ или введите ключ собеседника.");
}

export function getSecureChatState() {
  return {
    accountId: selectedAccountId,
    conversationId: selectedConversationId,
    key: encryptionKey,
    blocked: keyIsLoading || loadFailed || Boolean(currentPeerId && autoOptedIn && !encryptionKey && !serverProtected) || Boolean(encryptionKey && !serverProtected),
    requiresKey: (serverProtected || protectedHistorySeen || waitingPeer) && !encryptionKey,
    protected: serverProtected,
    automatic: automaticMode,
    waitingPeer
  };
}

export function requireProtectedConversationKey(accountId, conversationId, seen) {
  if (selectedAccountId !== accountId || selectedConversationId !== conversationId) return;
  if (seen) protectedHistorySeen = true;
  updatePresentation();
}

export async function setSecureConversation(account, chat, {force=false}={}) {
  // Refreshing a chat after enabling protection must NOT erase the one-time
  // secret from the still-open dialog or invalidate its freshly saved key.
  if (!force && account?.userId && chat?.conversationId &&
      selectedAccountId === account.userId && selectedConversationId === chat.conversationId &&
      !groupConversation && chat.kind !== 'group') {
    serverProtected = serverProtected || chat.encryptionMode === 'protected';
    automaticMode = automaticMode || Boolean(chat.autoProtection);
    updatePresentation();
    return;
  }
  const serial = ++requestSerial;
  selectedAccountId = account?.userId ?? null;
  selectedConversationId = chat?.conversationId ?? null;
  groupConversation = chat?.kind === 'group';
  currentPeerId=!groupConversation ? chat?.peer?.userId??null : null;
  autoOptedIn=false;
  serverProtected = !groupConversation && chat?.encryptionMode === 'protected';
  automaticMode=Boolean(chat?.autoProtection && serverProtected);
  waitingPeer=false;
  autoError='';
  activationFailed = false;
  encryptionKey = null;
  keyIsLoading = Boolean(selectedAccountId && selectedConversationId && !groupConversation);
  loadFailed = false;
  protectedHistorySeen = false;
  clearGeneratedSecret();
  updatePresentation();
  if (!keyIsLoading) return;
  const accountId = selectedAccountId;
  const conversationId = selectedConversationId;
  try {
    const found = await loadConversationKey(accountId, conversationId);
    if (serial !== requestSerial) return;
    encryptionKey = found;
    const identity=currentPeerId ? await existingIdentity(accountId) : null;
    if(serial!==requestSerial)return;
    autoOptedIn=Boolean(identity);
    if(!found && currentPeerId &&
       ((!serverProtected && autoOptedIn) || (serverProtected && automaticMode))){
      const key=await deriveAutoChatKey({accountId,peerUserId:currentPeerId,conversationId});
      if(serial!==requestSerial)return;
      if(!key){waitingPeer=true;return;}
      if(!serverProtected){
        const result=await api(`/api/v1/chats/${conversationId}/protection/auto`,{
          method:'POST',body:'{}'
        });
        if(serial!==requestSerial)return;
        if(!result.autoProtection)throw new Error('Сервер не подтвердил автоматическую защиту.');
      }
      encryptionKey=key;
      serverProtected=true;
      automaticMode=true;
      waitingPeer=false;
    }
  } catch(error) {
    if (serial !== requestSerial) return;
    autoError='Автоматический обмен не удался: '+error.message;
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

async function activateProtection(expectedAccountId,expectedConversationId,expectedSerial) {
  if(groupConversation || !encryptionKey || expectedSerial !== requestSerial) return;
  try {
    const result=await api(`/api/v1/chats/${expectedConversationId}/protection`,{
      method:'POST',body:JSON.stringify({})
    });
    if(expectedSerial!==requestSerial || selectedAccountId!==expectedAccountId) return;
    serverProtected=result.encryptionMode==='protected';
    activationFailed=!serverProtected;
    updatePresentation();
    updateMessages?.();
  }catch(error){
    if(expectedSerial!==requestSerial)return;
    activationFailed=true;
    updatePresentation();
    setStatus('Ключ сохранён, но защита на сервере не включилась. Проверьте соединение и нажмите «Включить защиту чата».');
  }
}

export function setupSecureChat({ onKeyChanged, verifyCandidateKey } = {}) {
  updateMessages = onKeyChanged ?? null;
  const dialog = element("secure-chat-dialog");
  element("secure-chat-open")?.addEventListener("click", () => {
    updatePresentation();
    dialog?.showModal();
    element("secure-chat-title")?.focus();
  });
  const canClose = () => !lastGeneratedSecret || window.confirm('Вы сохранили ключ вне Бульбама? После закрытия нельзя будет повторно показать этот секрет.');
  element("secure-chat-close")?.addEventListener("click", () => {if(canClose())dialog?.close();});
  dialog?.addEventListener('cancel',event=>{if(!canClose())event.preventDefault();});
  element('secure-chat-forget')?.addEventListener('click',async()=>{
    if(!encryptionKey||!selectedAccountId||!selectedConversationId)return;
    if(!window.confirm('Удалить местный ключ? Доступ к защищённым сообщениям исчезнет до повторного импорта того же ключа. На сервере защита останется включённой.'))return;
    const serial=requestSerial;
    const accountId=selectedAccountId,conversationId=selectedConversationId;
    try{
      await forgetConversationKey(accountId,conversationId);
      if(requestSerial!==serial)return;
      encryptionKey=null;
      clearGeneratedSecret();
      protectedHistorySeen=true;
      updatePresentation();
      setStatus('Локальный ключ удалён. Чтобы снова читать переписку, импортируйте прежний ключ.');
      updateMessages?.();
    }catch(error){setStatus('Не удалось удалить местный ключ: '+error.message);}
  });
  element('secure-chat-activate')?.addEventListener('click',()=>void activateProtection(selectedAccountId,selectedConversationId,requestSerial));
  element('secure-chat-enroll-auto')?.addEventListener('click',async()=>{
    if(!selectedAccountId||!selectedConversationId||serverProtected||autoOptedIn)return;
    if(document.querySelector('#voice-record-button')?.getAttribute('aria-pressed')==='true'){
      setStatus('Сначала завершите запись голосового перед сменой режима шифрования.');
      return;
    }
    if(!window.confirm('Автоматическая защита пока поддерживает только первое зарегистрированное устройство аккаунта. Другой iPhone или Mac не сможет читать новые сообщения без будущей процедуры подключения. Включить на этом устройстве?'))return;
    const serial=requestSerial;
    try{
      await registerIdentity(selectedAccountId);
      if(serial!==requestSerial)return;
      autoOptedIn=true;
      await setSecureConversation({userId:selectedAccountId},{kind:'direct',conversationId:selectedConversationId,
        peer:{userId:currentPeerId},encryptionMode:'plain'},{force:true});
    }catch(error){setStatus('Не удалось включить обмен: '+error.message);}
  });
  element('secure-chat-retry-auto')?.addEventListener('click',()=>{
    const account={userId:selectedAccountId};
    const chat={conversationId:selectedConversationId,kind:'direct',
      peer:{userId:currentPeerId},encryptionMode:serverProtected?'protected':'plain',
      autoProtection:automaticMode};
    if(account.userId && chat.conversationId && chat.peer.userId)
      void setSecureConversation(account,chat,{force:true});
  });
  dialog?.addEventListener("close", () => {
    clearGeneratedSecret();
    const input = element("secure-chat-key-input");
    if (input) input.value = "";
    element("secure-chat-open")?.focus();
  });
  element("secure-chat-generate")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (encryptionKey || keyIsLoading || loadFailed || !selectedConversationId || autoOptedIn ||
        serverProtected || protectedHistorySeen) return;
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
      await activateProtection(accountId,conversationId,serial);
    } catch (error) {
      setStatus("Не удалось создать ключ: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
  element("secure-chat-save")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (encryptionKey || keyIsLoading || loadFailed || !selectedConversationId || automaticMode) return;
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
      await verifyCandidateKey?.(input.value, accountId, conversationId);
      if (serial !== requestSerial) return;
      const key = await saveConversationKey(accountId, conversationId, input.value);
      input.value = "";
      if (serial !== requestSerial) return;
      encryptionKey = key;
      updatePresentation();
      setStatus("Ключ сохранён на этом устройстве. Включаю серверную защиту переписки.");
      updateMessages?.();
      await activateProtection(accountId,conversationId,serial);
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
