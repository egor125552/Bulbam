import { api } from "./api.js";
import { language } from "./i18n.js";
import { formatPresence } from "./presence-format.js";

let accountId = null;
let heartbeatTimer = null;
let refreshTimer = null;
let requestInFlight = false;
let generation = 0;
let statusList = [];
let sharePresence = true;

export function setupPresence() {
  const checkbox = document.querySelector("#presence-share");
  checkbox?.addEventListener("change", async () => {
    if (!accountId) return;
    const userId=accountId;
    const before=sharePresence;
    const status=document.querySelector("#presence-settings-status");
    if(status)status.textContent="Сохраняю настройку активности…";
    checkbox.disabled=true;
    try {
      const response = await api("/api/v1/presence/settings", {
        method: "PUT",body:JSON.stringify({sharePresence:checkbox.checked})
      });
      if (accountId!==userId)return;
      sharePresence=response.sharePresence;
      checkbox.checked=sharePresence;
      if(status)status.textContent=sharePresence
        ? "Собеседники могут видеть вашу активность."
        : "Ваша активность скрыта от собеседников.";
    } catch {
      if (accountId===userId) {
        checkbox.checked=before;
        if(status)status.textContent="Не удалось сохранить настройку активности. Попробуйте снова.";
      }
    } finally {
      if (accountId===userId)checkbox.disabled=false;
    }
  });

  window.addEventListener("bulbam:language-changed", () => publishPresence());
  window.addEventListener("bulbam:account-changed", (event) => {
    generation++;
    clearInterval(heartbeatTimer);
    clearInterval(refreshTimer);
    heartbeatTimer=null;
    refreshTimer=null;
    accountId=event.detail?.account?.userId ?? null;
    statusList=[];
    publishPresence();
    if (!accountId) {
      const status=document.querySelector("#presence-settings-status");
      if(status)status.textContent="";
      return;
    }
    const currentGeneration=generation;
    void loadSettings(currentGeneration);
    void heartbeat();
    void refreshPresence();
    heartbeatTimer=setInterval(()=>void heartbeat(),20000);
    refreshTimer=setInterval(()=>void refreshPresence(),15000);
  });

  document.addEventListener("visibilitychange", () => {
    if (!accountId)return;
    void heartbeat();
    if (document.visibilityState==="visible")void refreshPresence();
  });
  window.addEventListener("pagehide", () => {
    // A short-lived visibility lease also expires if the browser suspends
    // requests before pagehide reaches the Worker.
    if (accountId)void heartbeat(false);
  });
  window.addEventListener("online", () => {
    if (!accountId)return;
    void heartbeat();
    void refreshPresence();
  });
}

async function heartbeat(visible=document.visibilityState==="visible") {
  if (!accountId)return;
  try {
    await api("/api/v1/presence/heartbeat", {
      method:"PUT",keepalive:!visible,body:JSON.stringify({visible})
    });
  } catch {
    // Foreground lease expires automatically when the connection is lost.
  }
}

async function loadSettings(currentGeneration) {
  try {
    const result=await api("/api/v1/presence/settings");
    if(currentGeneration!==generation)return;
    sharePresence=result.sharePresence!==false;
    const checkbox=document.querySelector("#presence-share");
    if(checkbox)checkbox.checked=sharePresence;
  } catch {
    // Default to the server default until preferences are available.
  }
}

async function refreshPresence() {
  if (!accountId || requestInFlight || document.visibilityState!=="visible")return;
  requestInFlight=true;
  const currentGeneration=generation;
  try {
    const result=await api("/api/v1/presence");
    if(currentGeneration!==generation)return;
    statusList=Array.isArray(result.users)?result.users:[];
    publishPresence();
  } catch {
    // Do not falsely claim someone is online if their status cannot be read.
    if(currentGeneration===generation){statusList=[];publishPresence();}
  } finally {
    requestInFlight=false;
  }
}

function publishPresence() {
  const users=statusList.map(status=>({
    ...status,label:formatPresence(status,Date.now(),language())
  }));
  window.dispatchEvent(new CustomEvent("bulbam:presence-updated",{detail:{users}}));
}
