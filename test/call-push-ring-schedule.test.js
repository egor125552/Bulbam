import {describe,expect,test,vi,afterEach} from "vitest";
const mocks=vi.hoisted(()=>({
 notify:vi.fn(async()=>{}),isForeground:vi.fn(async()=>false)
}));
vi.mock("../worker/src/modules/realtime/public",()=>({
 DurableObjectRealtime:class{
  publishToUsers=vi.fn(async()=>{});
  setActiveCall=vi.fn(async()=>{});
  clearActiveCall=vi.fn(async()=>{});
 }
}));
vi.mock("../worker/src/modules/notifications/infrastructure/d1-push-repository",()=>({
 D1PushRepository:class{
  isForeground=(...args)=>mocks.isForeground(...args);
 }
}));
vi.mock("../worker/src/modules/notifications/application/push-notification-service",()=>({
 PushNotificationService:class{
  notifyIncomingCall=(...args)=>mocks.notify(...args);
 }
}));
import {CallRoom} from "../worker/src/modules/calls/infrastructure/call-room";
const caller="11111111-1111-4111-8111-111111111111";
const callee="22222222-2222-4222-8222-222222222222";
const callId="33333333-3333-4333-8333-333333333333";
const chatId="44444444-4444-4444-8444-444444444444";
const origin=1762370000000;
function makeRoom(){
 const data=new Map();
 const alarms=[];
 const storage={
  get:async key=>data.get(key),
  put:async(key,val)=>{if(typeof key==="object"){for(const [k,v] of Object.entries(key))data.set(k,v);}else data.set(key,val);},
  delete:async key=>data.delete(key),
  deleteAll:async()=>data.clear(),
  setAlarm:async t=>alarms.push(Number(t)),
  deleteAlarm:vi.fn(async()=>alarms.push(null))
 };
 const room=new CallRoom({storage},{
  REALTIME:{},DB:{},VAPID_PUBLIC_KEY:"test",VAPID_PRIVATE_KEY:"test",VAPID_SUBJECT:"mailto:test@example.org"
 });
 const call={
  callId,conversationId:chatId,callerUserId:caller,calleeUserId:callee,
  caller:{userId:caller,username:"caller",displayName:"Звонящий"},
  callee:{userId:callee,username:"callee",displayName:"Получатель"},createdAt:origin,
  status:"ringing",updatedAt:origin
 };
 const post=(path,body)=>room.fetch(new Request("https://room.test"+path,{method:"POST",body:JSON.stringify(body)}));
 return {room,storage,alarms,call,post};
}
afterEach(()=>{vi.restoreAllMocks();mocks.notify.mockClear();mocks.isForeground.mockReset().mockResolvedValue(false);});
describe("Durable Object incoming call push cadence",()=>{
 test("sends at 5, 10, 15, 20, 25, 30 seconds and no seventh repeat",async()=>{
  let now=origin;
  vi.spyOn(Date,"now").mockImplementation(()=>now);
  const {room,alarms,call,post}=makeRoom();
  expect((await post("/start",{call})).status).toBe(200);
  expect(alarms.at(-1)).toBe(origin+5000);
  for(let i=1;i<=6;i++){
   now=origin+5000*i;
   await room.alarm();
   expect(mocks.notify).toHaveBeenCalledTimes(i);
   expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({callId,conversationId:chatId,recipientUserId:callee}));
   if(i<6)expect(alarms.at(-1)).toBe(origin+(i+1)*5000);
  }
  expect(alarms.at(-1)).toBe(null);
  now+=5000;
  await room.alarm();
  expect(mocks.notify).toHaveBeenCalledTimes(6);
 });
 test.each(["answer","decline","end"])("stops repeated notifications immediately on %s",async action=>{
  let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
  const {room,post,call,alarms}=makeRoom();
  await post("/start",{call});
  const actorUserId=action==="end"?caller:callee;
  const response=await post("/transition",{callId,actorUserId,action});
  expect(response.status).toBe(200);
  expect(alarms.at(-1)).toBe(null);
  now+=5000;await room.alarm();
  expect(mocks.notify).not.toHaveBeenCalled();
 });
 test("stops when recipient has opened app and skips notification",async()=>{
  let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
  const {room,post,call,alarms}=makeRoom();
  await post("/start",{call});
  mocks.isForeground.mockResolvedValueOnce(true);
  now+=5000;await room.alarm();
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(alarms.at(-1)).toBe(null);
 });
 test("a room cannot send repeats without configured push service",async()=>{
  let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
  const {room,post,call,alarms}=makeRoom();
  await post("/start",{call});
  now+=31000;await room.alarm();
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(alarms.at(-1)).toBe(null);
 });
});
test("failure to schedule repeat pushes never prevents the call from starting",async()=>{
 let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
 const {post,call,storage}=makeRoom();
 storage.setAlarm=vi.fn(async()=>{throw new Error("Alarm unavailable")});
 expect((await post("/start",{call})).status).toBe(200);
});
test("alarm cleanup failure cannot prevent accepting a call",async()=>{
 let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
 const {post,call,storage}=makeRoom();
 await post("/start",{call});
 storage.deleteAlarm=vi.fn(async()=>{throw new Error("Alarm unavailable")});
 expect((await post("/transition",{callId,actorUserId:callee,action:"answer"})).status).toBe(200);
});
test("an old repeat cannot cancel the next call's scheduled ring",async()=>{
 let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
 const {room,post,call,storage,alarms}=makeRoom();
 await post("/start",{call});
 const nextCallId="55555555-5555-4555-8555-555555555555";
 mocks.notify.mockImplementationOnce(async()=>{
  expect((await post("/transition",{callId,actorUserId:caller,action:"end"})).status).toBe(200);
  expect((await post("/start",{call:{...call,callId:nextCallId,createdAt:now}})).status).toBe(200);
 });
 now+=5000;
 await room.alarm();
 expect((await storage.get("ringingPushRepeats")).callId).toBe(nextCallId);
 expect(alarms.at(-1)).toBe(now+5000);
});
test("an early alarm does not send the next call's push before five seconds",async()=>{
 let now=origin;vi.spyOn(Date,"now").mockImplementation(()=>now);
 const {room,post,call,alarms}=makeRoom();
 await post("/start",{call});
 now+=1000;await room.alarm();
 expect(mocks.notify).not.toHaveBeenCalled();
 expect(alarms.at(-1)).toBe(origin+5000);
});
