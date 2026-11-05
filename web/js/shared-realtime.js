// One browser tab, one authenticated realtime connection, many independent listeners.
let socket=null,accountId=null,retryTimer=null,heartbeatTimer=null,delay=1000;
const listeners=new Set();

function stopConnection(){
  clearTimeout(retryTimer);retryTimer=null;
  clearInterval(heartbeatTimer);heartbeatTimer=null;
  const previous=socket;socket=null;
  if(previous)try{previous.close();}catch{}
}
function connect(){
  if(!accountId||!listeners.size||socket?.readyState===WebSocket.OPEN||socket?.readyState===WebSocket.CONNECTING)return;
  clearTimeout(retryTimer);
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  const active=new WebSocket(`${protocol}//${location.host}/api/v1/realtime`);
  socket=active;
  active.addEventListener("open",()=>{
    if(socket!==active)return;
    delay=1000;
    clearInterval(heartbeatTimer);
    heartbeatTimer=setInterval(()=>{
      if(socket===active && active.readyState===WebSocket.OPEN)active.send("ping");
    },25000);
    for(const listener of listeners)listener.open?.();
  });
  active.addEventListener("message",event=>{
    if(socket!==active)return;
    let payload;
    try{payload=JSON.parse(String(event.data));}catch{return;}
    for(const listener of listeners)listener.message?.(payload);
  });
  active.addEventListener("close",()=>{
    if(socket!==active)return;
    socket=null;
    clearInterval(heartbeatTimer);heartbeatTimer=null;
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
export function reconnectRealtime(){connect();}
export function realtimeConnected(){return socket?.readyState===WebSocket.OPEN;}
