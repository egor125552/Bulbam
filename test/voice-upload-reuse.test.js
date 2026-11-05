import {test,expect,vi} from "vitest";
import {canReuseVoiceUploadTransport} from "../web/js/voice-upload-socket.js";

test("newly stopped recording reuses the still-open upload socket, unlike interrupted drafts",()=>{
 const previous=globalThis.WebSocket;
 globalThis.WebSocket={OPEN:1};
 try{
   const transport={sessionId:"voice-session",socket:{readyState:1}};
   const upload={sessionId:"voice-session",transport:"websocket"};
   expect(canReuseVoiceUploadTransport(transport,upload)).toBe(true);
   expect(canReuseVoiceUploadTransport(null,upload)).toBe(false);
   expect(canReuseVoiceUploadTransport(transport,{sessionId:"different"})).toBe(false);
   transport.socket.readyState=3;
   expect(canReuseVoiceUploadTransport(transport,upload)).toBe(false);
 }finally{
   if(previous===undefined)delete globalThis.WebSocket;else globalThis.WebSocket=previous;
 }
});
