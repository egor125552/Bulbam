import { api, deviceName } from "./api.js";
import { announce, getCurrentAccount } from "./ui.js";

// Native WebAuthn is used intentionally: the secret key is held by Safari,
// iCloud Keychain or a hardware authenticator, never by our JavaScript.
let conditionalController = null;
let onSignedIn = null;

function toBytes(value) {
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function toBase64URL(data) {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function credentialJSON(value, mode) {
  const result = {
    id: value.id,
    rawId: toBase64URL(value.rawId),
    type: value.type,
    clientExtensionResults: value.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: value.authenticatorAttachment ?? undefined
  };
  if (mode === "register") {
    result.response = {
      clientDataJSON: toBase64URL(value.response.clientDataJSON),
      attestationObject: toBase64URL(value.response.attestationObject),
      transports: value.response.getTransports?.() ?? []
    };
  } else {
    result.response = {
      clientDataJSON: toBase64URL(value.response.clientDataJSON),
      authenticatorData: toBase64URL(value.response.authenticatorData),
      signature: toBase64URL(value.response.signature),
      userHandle: value.response.userHandle ? toBase64URL(value.response.userHandle) : undefined
    };
  }
  return result;
}
function registrationPublicKey(options) {
  return {
    ...options,
    challenge: toBytes(options.challenge),
    user: { ...options.user, id: toBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(item => ({
      ...item, id: toBytes(item.id)
    }))
  };
}
function authenticationPublicKey(options) {
  return {
    ...options,
    challenge: toBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(item => ({
      ...item, id: toBytes(item.id)
    }))
  };
}
function supported() {
  return window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;
}
function setStatus(message) {
  const el = document.querySelector("#passkey-status");
  if (el) el.textContent = message;
  announce(message);
}
function stopConditionalAutofill() {
  conditionalController?.abort();
  conditionalController = null;
}
async function verifyAndSignIn(begin, credential) {
  const data = await api("/api/v1/passkeys/authentication/verify", {
    method: "POST",
    body: JSON.stringify({
      challengeId: begin.challengeId,
      response: credentialJSON(credential, "login"),
      deviceName: deviceName()
    })
  });
  stopConditionalAutofill();
  await onSignedIn?.(data.account, data.session);
}
export async function signInWithPasskey() {
  if (!supported()) {
    announce("Ключи доступа на этом устройстве или в браузере не поддерживаются.");
    return;
  }
  stopConditionalAutofill();
  const button = document.querySelector("#login-passkey");
  if (button) button.disabled = true;
  try {
    const begin = await api("/api/v1/passkeys/authentication/options", {method:"POST"});
    const credential = await navigator.credentials.get({
      publicKey: authenticationPublicKey(begin.options)
    });
    if (!credential) throw new Error("Ключ доступа не выбран.");
    await verifyAndSignIn(begin, credential);
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError")
      announce("Вход по ключу доступа отменён.");
    else announce("Вход по ключу доступа не выполнен: " + error.message);
  } finally {
    if (button) button.disabled = false;
  }
}
export async function startPasskeyAutofill() {
  stopConditionalAutofill();
  if (!supported() || getCurrentAccount()) return;
  if (typeof PublicKeyCredential.isConditionalMediationAvailable !== "function") return;
  try {
    if (!await PublicKeyCredential.isConditionalMediationAvailable()) return;
    const begin = await api("/api/v1/passkeys/authentication/options", {method:"POST"});
    if (getCurrentAccount()) return;
    conditionalController = new AbortController();
    const credential = await navigator.credentials.get({
      mediation: "conditional",
      publicKey: authenticationPublicKey(begin.options),
      signal: conditionalController.signal
    });
    if (credential && !getCurrentAccount()) await verifyAndSignIn(begin,credential);
  } catch(error) {
    if (error.name !== "AbortError" && error.name !== "NotAllowedError") {
      // Conditional autofill is optional; never interrupt password entry.
      console.warn("Passkey autofill unavailable",error);
    }
  }
}
async function enrollPasskey() {
  if (!supported()) {
    setStatus("Создание ключей доступа не поддерживается на этом устройстве.");
    return;
  }
  const button=document.querySelector("#create-passkey");
  if(button) button.disabled=true;
  try {
    const begin=await api("/api/v1/passkeys/registration/options",{method:"POST"});
    const credential=await navigator.credentials.create({
      publicKey:registrationPublicKey(begin.options)
    });
    if(!credential) throw new Error("Ключ доступа не создан.");
    await api("/api/v1/passkeys/registration/verify",{
      method:"POST",
      body:JSON.stringify({
        challengeId:begin.challengeId,
        response:credentialJSON(credential,"register"),
        name:deviceName()
      })
    });
    setStatus("Ключ доступа создан. Теперь можно входить без пароля.");
    await refreshPasskeys();
  } catch(error) {
    if(error.name === "NotAllowedError" || error.name === "AbortError")
      setStatus("Создание ключа отменено.");
    else setStatus("Не удалось создать ключ доступа: "+error.message);
  } finally {
    if(button) button.disabled=false;
  }
}
async function refreshPasskeys() {
  if(!getCurrentAccount()) return;
  const list=document.querySelector("#passkey-list");
  if(!list) return;
  try {
    const result=await api("/api/v1/passkeys");
    list.replaceChildren();
    if(!result.passkeys?.length){
      const li=document.createElement("li");
      li.textContent="Ключей доступа пока нет.";
      list.append(li);
      return;
    }
    for(const key of result.passkeys){
      const li=document.createElement("li");
      const title=document.createElement("span");
      title.textContent=key.name+" · "+new Date(key.createdAt).toLocaleDateString();
      const remove=document.createElement("button");
      remove.type="button";
      remove.textContent="Удалить ключ";
      remove.setAttribute("aria-label","Удалить ключ доступа "+key.name);
      remove.addEventListener("click",async()=>{
        if(!confirm("Удалить этот ключ доступа? Парольный вход останется доступен."))return;
        remove.disabled=true;
        try{
          await api("/api/v1/passkeys/"+encodeURIComponent(key.id),{method:"DELETE"});
          setStatus("Ключ удалён.");
          await refreshPasskeys();
        }catch(error){setStatus("Не удалось удалить ключ: "+error.message);remove.disabled=false;}
      });
      li.append(title, " ",remove);
      list.append(li);
    }
  } catch(error) {
    setStatus("Не удалось загрузить ключи доступа: "+error.message);
  }
}
export function setupPasskeys(callback) {
  onSignedIn=callback;
  document.querySelector("#login-passkey")?.addEventListener("click",()=>void signInWithPasskey());
  document.querySelector("#create-passkey")?.addEventListener("click",()=>void enrollPasskey());
  document.querySelector("#refresh-passkeys")?.addEventListener("click",()=>void refreshPasskeys());
  window.addEventListener("bulbam:account-changed",(event)=>{
    if(event.detail?.account) {
      stopConditionalAutofill();
      void refreshPasskeys();
    }
  });
}
export function cancelPasskeyAutofill(){ stopConditionalAutofill(); }
