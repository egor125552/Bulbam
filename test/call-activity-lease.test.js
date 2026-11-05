import {afterEach,expect,test,vi} from "vitest";
import {CallRoom} from "../worker/src/modules/calls/infrastructure/call-room.ts";

afterEach(()=>vi.restoreAllMocks());
test("accepted call remains alive through state polls and expires when every client disappears",async()=>{
 let now=1_000_000;
 vi.spyOn(Date,"now").mockImplementation(()=>now);
 const entries=new Map(),leaseWrites=[];
 const storage={
   get:async key=>entries.get(key),
   put:async(key,value)=>{entries.set(key,value);}
 };
 const env={REALTIME:{getByName:uid=>({fetch:async request=>{
   if(new URL(request.url).pathname==="/active-call" && request.method==="POST")
     leaseWrites.push({user:uid,...await request.json()});
   return Response.json({ok:true});
 }})}};
 const room=new CallRoom({storage},env);
 const call={
   callId:"test-call",conversationId:"test-chat",callerUserId:"alice",calleeUserId:"bob",
   caller:{userId:"alice",username:"a",displayName:"Alice"},
   callee:{userId:"bob",username:"b",displayName:"Bob"},createdAt:now
 };
 const start=await room.fetch(new Request("https://room.internal/start",{method:"POST",body:JSON.stringify({call})}));
 expect(start.status).toBe(200);
 now+=5_000;
 const answered=await room.fetch(new Request("https://room.internal/transition",{method:"POST",body:JSON.stringify({
   callId:"test-call",actorUserId:"bob",actorSessionId:"bob-session",action:"answer"
 })}));
 expect((await answered.json()).call.status).toBe("accepted");
 expect(leaseWrites.at(-1).expiresAt).toBe(now+90_000);
 now+=60_000;
 const poll=await room.fetch(new Request("https://room.internal/call?callId=test-call&viewerUserId=alice"));
 expect((await poll.json()).call.status).toBe("accepted");
 expect(entries.get("activeCall").updatedAt).toBe(now);
 expect(leaseWrites.at(-1).expiresAt).toBe(now+90_000);
 now+=91_000;
 const expired=await room.fetch(new Request("https://room.internal/call?callId=test-call&viewerUserId=alice"));
 expect((await expired.json()).call.status).toBe("ended");
 expect(entries.get("activeCall").endedByUserId).toBe("system-timeout");
});
