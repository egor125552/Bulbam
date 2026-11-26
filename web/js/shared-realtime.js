// One browser tab, one authenticated realtime connection, many independent listeners.
const HEARTBEAT_MS = 25_000;
const PONG_TIMEOUT_MS = 8_000;

let socket=null,accountId=null,retryTimer=null,heartbeatTimer=null,pongTimer=null,delay=1000,lifecycleBound=false;
const listeners=new Set();

function clearPongTimer(){
  clearTimeout(pongTimer);
  pongTimer=null;
}

function stopConnection(){
  clearTimeout(retryTimer);retryTimer=null;
  clearInterval(heartbeatTimer);heartbeatTimer=null;
  clearPongTimer();
  const previous=socket;socket=null;
  if(previous)try{previous.close();}catch{}
}

function bindLifecycleOnce(){
  if(lifecycleBound)return;
  lifecycleBound=true;
  if(typeof window!=="undefined" && typeof window.addEventListener==="function"){
    window.addEventListener("online",()=>{
      if(!accountId || !listeners.size)return;
      delay=1000;
      clearTimeout(retryTimer);retryTimer=null;
      connect();
    });
  }
  if(typeof document!=="undefined" && typeof document.addEventListener==="function"){
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState!=="visible" || !accountId || !listeners.size)return;
      if(socket?.readyState===WebSocket.OPEN){
        sendPing(socket);
        return;
      }
      delay=1000;
      clearTimeout(retryTimer);retryTimer=null;
      connect();
    });
  }
}

function sendPing(active){
  if(socket!==active || active.readyState!==WebSocket.OPEN)return;
  try{
    active.send("ping");
  }catch{
    try{active.close();}catch{}
    return;
  }
  if(!pongTimer){
    pongTimer=setTimeout(()=>{
      pongTimer=null;
      if(socket===active){
        try{active.close();}catch{}
      }
    },PONG_TIMEOUT_MS);
  }
}

function connect(){
  if(!accountId||!listeners.size||socket?.readyState===WebSocket.OPEN||socket?.readyState===WebSocket.CONNECTING)return;
  if(typeof navigator!=="undefined" && navigator.onLine===false)return;
  clearTimeout(retryTimer);retryTimer=null;
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  const active=new WebSocket(`${protocol}//${location.host}/api/v1/realtime`);
  socket=active;
  active.addEventListener("open",()=>{
    if(socket!==active)return;
    delay=1000;
    clearPongTimer();
    clearInterval(heartbeatTimer);
    heartbeatTimer=setInterval(()=>sendPing(active),HEARTBEAT_MS);
    for(const listener of listeners)listener.open?.();
  });
  active.addEventListener("message",event=>{
    if(socket!==active)return;
    clearPongTimer();
    let payload;
    try{payload=JSON.parse(String(event.data));}catch{return;}
    if(payload?.type==="pong")return;
    for(const listener of listeners)listener.message?.(payload);
  });
  active.addEventListener("close",()=>{
    if(socket!==active)return;
    socket=null;
    clearInterval(heartbeatTimer);heartbeatTimer=null;
    clearPongTimer();
    for(const listener of listeners)listener.close?.();
    if(listeners.size){
      const timeout=delay;delay=Math.min(15000,delay*2);
      retryTimer=setTimeout(connect,timeout);
    }
  });
  active.addEventListener("error",()=>{if(socket===active)try{active.close();}catch{}});
}

export function subscribeRealtime(userId, listener){
  if(!userId)return ()=>{};
  bindLifecycleOnce();
  if(accountId!==userId){
    stopConnection();
    listeners.clear();
    accountId=userId;delay=1000;
  }
  listeners.add(listener);
  connect();
  if(socket?.readyState===WebSocket.OPEN)listener.open?.();
  return ()=>{
    listeners.delete(listener);
    if(!listeners.size){accountId=null;stopConnection();}
  };
}
export function reconnectRealtime({ resetBackoff = false } = {}){
  if(resetBackoff){
    delay=1000;
    clearTimeout(retryTimer);retryTimer=null;
  }
  connect();
}
export function realtimeConnected(){return socket?.readyState===WebSocket.OPEN;}
