import {test,expect,vi,afterEach} from "vitest";
import {CallRoom} from "../worker/src/modules/calls/infrastructure/call-room.ts";
const peer=(id)=>({userId:id,username:id,displayName:id});
function fixture(){
 const data=new Map();
 const storage={
  get:async k=>data.get(k),
  put:async (k,v)=>data.set(k,v),
  delete:async k=>data.delete(k),
  deleteAlarm:async()=>{},
  setAlarm:async()=>{}
 };
 const events=[];
 const env={REALTIME:{getByName:userId=>({
  fetch:async request=>{
   if(new URL(request.url).pathname==="/publish")
    events.push({userId,body:await request.json()});
   return Response.json({ok:true});
  }
 })}};
 const room=new CallRoom({storage},env);
 const call={
  callId:"call-1",conversationId:"chat-1",callerUserId:"alice",calleeUserId:"bob",
  caller:peer("alice"),callee:peer("bob"),createdAt:Date.now()
 };
 const post=(url,body)=>room.fetch(new Request("https://room.test"+url,{method:"POST",body:JSON.stringify(body)}));
 const get=(url)=>room.fetch(new Request("https://room.test"+url));
 return {room,post,get,call,data,events};
}
test("caller may send SDP and ICE during ringing, but callee cannot answer SDP or emit audio early",async()=>{
 const {post,get,call}=fixture();
 expect((await post("/start",{call})).status).toBe(200);
 const offer=await post("/signal",{callId:call.callId,actorUserId:"alice",kind:"offer",payload:{type:"offer",sdp:"v=0"}});
 expect(offer.status).toBe(201);
 const candidate=await post("/signal",{callId:call.callId,actorUserId:"alice",kind:"ice",payload:{candidate:"candidate:1"}});
 expect(candidate.status).toBe(201);
 const earlyAnswer=await post("/signal",{callId:call.callId,actorUserId:"bob",kind:"answer",payload:{type:"answer",sdp:"v=0"}});
 expect(earlyAnswer.status).toBe(409);
 const forgedOffer=await post("/signal",{callId:call.callId,actorUserId:"bob",kind:"offer",payload:{type:"offer",sdp:"v=0"}});
 expect(forgedOffer.status).toBe(409);
 const unrelated=await post("/signal",{callId:call.callId,actorUserId:"mallory",kind:"offer",payload:{type:"offer",sdp:"v=0"}});
 expect(unrelated.status).toBe(404);
 const accepted=await post("/transition",{callId:call.callId,actorUserId:"bob",action:"answer"});
 expect(accepted.status).toBe(200);
 const signals=await get("/signals?callId=call-1&viewerUserId=bob&after=0");
 expect((await signals.json()).signals.map(s=>s.kind)).toEqual(["offer","ice"]);
 const answer=await post("/signal",{callId:call.callId,actorUserId:"bob",kind:"answer",payload:{type:"answer",sdp:"v=0"}});
 expect(answer.status).toBe(201);
});
test("callee never sees stale preoffers after rejection or final hangup",async()=>{
 const {post,get,call}=fixture();
 await post("/start",{call});
 await post("/signal",{callId:call.callId,actorUserId:"alice",kind:"offer",payload:{type:"offer",sdp:"v=0"}});
 expect((await post("/transition",{callId:call.callId,actorUserId:"bob",action:"decline"})).status).toBe(200);
 const response=await get("/signals?callId=call-1&viewerUserId=bob&after=0");
 expect((await response.json()).signals).toEqual([]);
 expect((await post("/signal",{callId:call.callId,actorUserId:"alice",kind:"ice",payload:{candidate:"candidate:1"}})).status).toBe(409);
});
