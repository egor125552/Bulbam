import { generateConversationSecret, loadConversationKey, saveConversationKey, forgetConversationKey } from "./secure-messages.js";
import { api } from "./api.js";
import {isEncryptionFeatureEnabled} from './owner-features.js';
import { deriveAutoChatKey, registerIdentity, existingIdentity } from './auto-keys.js';

let selectedAccountId = null;
let selectedConversationId = null;
let encryptionKey = null;
let keyIsLoading = false;
let loadFailed = false;
let protectedHistorySeen = false;
let serverProtected = false;
let chatDisabled = false;
let currentProtectionOrigin = 'none';
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

// Normal protection state belongs in this dialog's single action button.
// Only actionable failures are announced to VoiceOver.
function setStatus(value) {
  const output = element("secure-chat-status");
  if (output) { output.hidden = true; output.textContent = value; output.removeAttribute('role'); }
}
function setError(value) {
  const output = element("secure-chat-status");
  if (output) { output.textContent = value; output.hidden = false; output.setAttribute('role', 'alert'); }
}

function updatePresentation() {
  const hasChat = Boolean(selectedAccountId && selectedConversationId && !groupConversation);
  const featureEnabled=isEncryptionFeatureEnabled();
  const active = Boolean(serverProtected && encryptionKey && !keyIsLoading && !loadFailed && !chatDisabled);
  const autoPending=Boolean(!chatDisabled && currentPeerId && (autoOptedIn || automaticMode) && !encryptionKey && !serverProtected);
  const open = element("secure-chat-open");
  // No visible, focusable or screen-reader-readable protection status in the chat header.
  if (open) open.hidden = !hasChat || !featureEnabled;
  const manualHint=element('secure-chat-manual-hint');
  if(manualHint)manualHint.hidden=automaticMode || autoPending || (!serverProtected && autoOptedIn);
  const disable = element('secure-chat-toggle-off');
  if(disable)disable.hidden=!hasChat || !serverProtected || !featureEnabled;
  const enable = element('secure-chat-toggle-on');
  if(enable)enable.hidden=!hasChat || serverProtected || !featureEnabled;
  // Legacy shared secrets are accessible only when recovery is necessary.
  const legacy=element('secure-chat-legacy-tools');
  if(legacy)legacy.hidden=!hasChat || !featureEnabled ||
    !(currentProtectionOrigin==='manual' && (!encryptionKey || activationFailed));
  const onboarding = element("secure-chat-onboarding");
  if (onboarding) onboarding.hidden = !hasChat || automaticMode || autoPending || Boolean(encryptionKey) || keyIsLoading || loadFailed;
  const generate = element("secure-chat-generate");
  if (generate) generate.hidden = serverProtected || protectedHistorySeen || autoPending || chatDisabled;
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
  const deviceRecording = hasChat && !chatDisabled && featureEnabled;
  if (recording) {
    recording.disabled = !deviceRecording && !chatDisabled && (keyIsLoading || loadFailed || autoPending || Boolean(encryptionKey && !serverProtected) || (serverProtected && !encryptionKey));
    // Do not repeat the encryption state in tooltip or VoiceOver announcements.
    recording.removeAttribute('title');
  }
  if (draftSend) draftSend.disabled = !deviceRecording && !chatDisabled && (keyIsLoading || loadFailed || autoPending || Boolean(encryptionKey && !serverProtected) || (serverProtected && !encryptionKey));
  if (!hasChat) setStatus("Откройте переписку.");
  else if (chatDisabled) setStatus('Обычные сообщения. Без сквозного шифрования');
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
    sendKey: chatDisabled ? null : encryptionKey,
    disabled: chatDisabled,
    blocked: !chatDisabled && (keyIsLoading || loadFailed || Boolean(currentPeerId && autoOptedIn && !encryptionKey && !serverProtected) || Boolean(encryptionKey && !serverProtected)),
    requiresKey: !chatDisabled && (serverProtected || protectedHistorySeen || waitingPeer) && !encryptionKey,
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
    serverProtected = chat.encryptionMode === 'protected';
    automaticMode = Boolean(chat.autoProtection);
    chatDisabled = Boolean(chat.encryptionOptOut);
    currentProtectionOrigin=chat.protectionOrigin??'none';
    if(chatDisabled){waitingPeer=false;loadFailed=false;}
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
  chatDisabled = !groupConversation && Boolean(chat?.encryptionOptOut);
  currentProtectionOrigin=chat?.protectionOrigin??'none';
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
    // Even after protection is switched off (or hidden globally), old
    // automatically encrypted messages still require the original ECDH key.
    const historicAuto=currentProtectionOrigin==='auto';
    const canStartProtection=!chatDisabled && isEncryptionFeatureEnabled() &&
      ((!serverProtected && autoOptedIn) || (serverProtected && automaticMode));
    if(!found && currentPeerId && identity && (canStartProtection || historicAuto)){
      const key=await deriveAutoChatKey({accountId,peerUserId:currentPeerId,conversationId});
      if(serial!==requestSerial)return;
      if(!key){waitingPeer=true;return;}
      if(!serverProtected && !chatDisabled){
        const result=await api(`/api/v1/chats/${conversationId}/protection/auto`,{
          method:'POST',body:'{}'
        });
        if(serial!==requestSerial)return;
        if(!result.autoProtection)throw new Error('Сервер не подтвердил автоматическую защиту.');
      }
      encryptionKey=key;
      if(!chatDisabled){serverProtected=true;automaticMode=true;}
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
  window.addEventListener('bulbam:features-changed',()=>{
    const active=isEncryptionFeatureEnabled();
    if(!active && !serverProtected){
      waitingPeer=false;
      loadFailed=false;
    }
    const dialog=element('secure-chat-dialog');
    if(!active && dialog?.open)dialog.close();
    updatePresentation();
    // The global setting arrives asynchronously after account initialization.
    // Once enabled, resume automatic key negotiation without another tap.
    if(active && selectedAccountId && selectedConversationId && currentPeerId &&
       !groupConversation && !chatDisabled && !encryptionKey && !keyIsLoading){
      void setSecureConversation({userId:selectedAccountId},{
        kind:'direct',conversationId:selectedConversationId,
        peer:{userId:currentPeerId},encryptionMode:serverProtected?'protected':'plain',
        autoProtection:automaticMode,encryptionOptOut:chatDisabled,
        protectionOrigin:currentProtectionOrigin
      },{force:true});
    }
  });
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
    }catch(error){setError('Не удалось удалить местный ключ: '+error.message);}
  });
  async function changeMode(enabled){
    if(!selectedAccountId||!selectedConversationId||groupConversation)return;
    const id=selectedConversationId,serial=requestSerial;
    const off=element('secure-chat-toggle-off'),on=element('secure-chat-toggle-on');
    if(off)off.disabled=true;
    if(on)on.disabled=true;
    setStatus('');
    try{
      if(enabled && !encryptionKey){
        if(currentProtectionOrigin==='manual')
          throw new Error('Для старой защищённой переписки нужен прежний ключ. Откройте восстановление ключа.');
        if(!currentPeerId)
          throw new Error('Не удалось определить собеседника для обмена ключами.');
        // No manual copying or pasting: register the local public identity and
        // independently derive the shared key once the peer has done the same.
        // Existing immutable account identities are never silently replaced.
        await registerIdentity(selectedAccountId);
        if(serial!==requestSerial)return;
        autoOptedIn=true;
        const restored=await deriveAutoChatKey({accountId:selectedAccountId,peerUserId:currentPeerId,
          conversationId:id});
        if(!restored)throw new Error('Ожидаю обновлённое устройство собеседника. Защита ещё не включена.');
        if(serial!==requestSerial)return;
        encryptionKey=restored;
      }
      const result=currentProtectionOrigin==='none' && encryptionKey && !autoOptedIn && enabled
        ? await api(`/api/v1/chats/${id}/protection`,{method:'POST',body:'{}'})
        : await api(`/api/v1/chats/${id}/protection/mode`,{
        method:'PUT',body:JSON.stringify({enabled})
      });
      if(serial!==requestSerial)return;
      chatDisabled=Boolean(result.encryptionOptOut);
      serverProtected=result.encryptionMode==='protected';
      automaticMode=Boolean(result.autoProtection);
      waitingPeer=false;loadFailed=false;
      updatePresentation();
      updateMessages?.();
      window.dispatchEvent(new CustomEvent('bulbam:chat-mode-changed',{detail:{conversationId:id}}));
    }catch(error){setError('Не удалось сохранить настройку: '+error.message);}
    finally{if(off)off.disabled=false;if(on)on.disabled=false;}
  }
  element('secure-chat-toggle-off')?.addEventListener('click',()=>void changeMode(false));
  element('secure-chat-toggle-on')?.addEventListener('click',()=>void changeMode(true));
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
    }catch(error){setError('Не удалось включить обмен: '+error.message);}
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
      setError("Не удалось создать ключ: " + error.message);
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
      setError("Ключ не принят: " + error.message);
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
      setError("Копирование не удалось. Выделите ключ в поле и скопируйте вручную.");
      element("secure-chat-key-output")?.focus();
      element("secure-chat-key-output")?.select();
    }
  });
}
