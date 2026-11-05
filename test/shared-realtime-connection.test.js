import {afterEach,describe,expect,test,vi} from "vitest";
import {subscribeRealtime,reconnectRealtime} from "../web/js/shared-realtime.js";

const originalSocket=globalThis.WebSocket;
const originalLocation=globalThis.location;
class FakeSocket{
 static OPEN=1;
 static CONNECTING=0;
 static instances=[];
 constructor(url){this.url=url;this.readyState=0;this.listeners=new Map();FakeSocket.instances.push(this);}
 addEventListener(name,callback){const callbacks=this.listeners.get(name)??[];callbacks.push(callback);this.listeners.set(name,callbacks);}
 emit(name,fields={}){for(const callback of this.listeners.get(name)??[])callback(fields);}
 open(){this.readyState=1;this.emit("open");}
 send(text){this.lastSent=text;}
 close(){if(this.readyState===3)return;this.readyState=3;this.emit("close");}
}
afterEach(()=>{
 globalThis.WebSocket=originalSocket;
 if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;
 vi.useRealTimers();
});
describe("shared realtime socket",()=>{
 test("messenger and calls receive all events on one connection",()=>{
   vi.useFakeTimers();FakeSocket.instances=[];
   globalThis.WebSocket=FakeSocket;globalThis.location={protocol:"https:",host:"bulbam.test"};
   const received=[];
   const stopMessages=subscribeRealtime("user-a",{message:e=>received.push(["messages",e.type])});
   const stopCalls=subscribeRealtime("user-a",{message:e=>received.push(["calls",e.type])});
   expect(FakeSocket.instances).toHaveLength(1);
   const active=FakeSocket.instances[0];
   active.open();
   active.emit("message",{data:JSON.stringify({type:"call.ringing"})});
   active.emit("message",{data:JSON.stringify({type:"message.created"})});
   expect(received).toEqual([
     ["messages","call.ringing"],["calls","call.ringing"],
     ["messages","message.created"],["calls","message.created"]
   ]);
   stopMessages();
   expect(active.readyState).toBe(1);
   active.emit("message",{data:JSON.stringify({type:"call.ended"})});
   expect(received.at(-1)).toEqual(["calls","call.ended"]);
   stopCalls();
   expect(active.readyState).toBe(3);
 });
 test("isolated call subscriber opens a single socket and reconnects after loss",()=>{
   vi.useFakeTimers();FakeSocket.instances=[];
   globalThis.WebSocket=FakeSocket;globalThis.location={protocol:"https:",host:"bulbam.test"};
   const stop=subscribeRealtime("user-b",{});
   expect(FakeSocket.instances).toHaveLength(1);
   FakeSocket.instances[0].open();
   FakeSocket.instances[0].close();
   vi.advanceTimersByTime(1000);
   expect(FakeSocket.instances).toHaveLength(2);
   reconnectRealtime();
   expect(FakeSocket.instances).toHaveLength(2);
   stop();
 });
});
