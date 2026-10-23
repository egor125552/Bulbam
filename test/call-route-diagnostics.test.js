import {test,expect} from "vitest";
import {hasTurnServer,readTemporaryTurnMode,writeTemporaryTurnMode,selectedIceRoute,iceTransportPolicy} from "../web/js/call-route-diagnostics.js";

function stats(localType,remoteType,{transport=true,nominated=true}={}){
  const rows=[
    {id:"pair",type:"candidate-pair",state:"succeeded",nominated,
      localCandidateId:"l",remoteCandidateId:"r"},
    {id:"l",type:"local-candidate",candidateType:localType,protocol:"udp"},
    {id:"r",type:"remote-candidate",candidateType:remoteType,protocol:"udp"}
  ];
  if(transport)rows.push({id:"transport",type:"transport",selectedCandidatePairId:"pair"});
  return new Map(rows.map(row=>[row.id,row]));
}
test("TURN route is reported only when the actually selected ICE pair relays",()=>{
  expect(selectedIceRoute(stats("relay","srflx")).kind).toBe("turn");
  expect(selectedIceRoute(stats("host","relay")).kind).toBe("turn");
  expect(selectedIceRoute(stats("srflx","srflx")).kind).toBe("stun");
  expect(selectedIceRoute(stats("host","host")).kind).toBe("direct");
});
test("works with older browsers exposing only nominated candidate pairs",()=>{
  expect(selectedIceRoute(stats("relay","host",{transport:false})).kind).toBe("turn");
  expect(selectedIceRoute(new Map()).kind).toBe("unknown");
});
test("TURN availability requires an ICE server URL, not just an installed VPS service",()=>{
  expect(hasTurnServer([{urls:"stun:stun.cloudflare.com:3478"}])).toBe(false);
  expect(hasTurnServer([{urls:["stun:x","turn:169.58.224.216:3478?transport=udp"],username:"temporary"}])).toBe(true);
  expect(hasTurnServer([{urls:"turns:turn.example.com:5349"}])).toBe(true);
});
test("temporary relay mode is tab-scoped and reversible",()=>{
  const values=new Map();
  const storage={
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,value),
    removeItem:key=>values.delete(key)
  };
  expect(readTemporaryTurnMode(storage)).toBe(false);
  expect(writeTemporaryTurnMode(true,storage)).toBe(true);
  expect(readTemporaryTurnMode(storage)).toBe(true);
  expect(writeTemporaryTurnMode(false,storage)).toBe(true);
  expect(readTemporaryTurnMode(storage)).toBe(false);
});

test("forcing TURN truly sets WebRTC relay policy and fails closed without relay",()=>{
  const stun=[{urls:"stun:stun.cloudflare.com:3478"}];
  const turn=[{urls:"turn:169.58.224.216:3478?transport=udp",
    username:"example-user",credential:"example-only"}];
  expect(iceTransportPolicy(stun,false)).toBe("all");
  expect(iceTransportPolicy(turn,true)).toBe("relay");
  expect(()=>iceTransportPolicy(stun,true)).toThrow(/TURN/);
});
