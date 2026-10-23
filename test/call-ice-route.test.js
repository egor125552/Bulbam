import {test,expect} from "vitest";
import {
  selectedIceRoute,hasTurnCredentials,readIcePolicy,saveIcePolicy
} from "../web/js/call-ice-route.js";

const stats=(...reports)=>{
  const records=new Map(reports.map(r=>[r.id,r]));
  records.forEach=Map.prototype.forEach.bind(records);
  return records;
};
const local={id:"local",type:"local-candidate",candidateType:"host"};
const remote={id:"remote",type:"remote-candidate",candidateType:"host"};
const pair={id:"pair",type:"candidate-pair",state:"succeeded",
  nominated:true,localCandidateId:"local",remoteCandidateId:"remote"};
test("reported selected relay is TURN, whether local or remote",()=>{
  const transport={id:"transport",type:"transport",selectedCandidatePairId:"pair"};
  expect(selectedIceRoute(stats(transport,pair,{...local,candidateType:"relay"},remote)).kind).toBe("turn");
  expect(selectedIceRoute(stats(transport,pair,local,{...remote,candidateType:"relay"})).kind).toBe("turn");
});
test("selected srflx is a direct STUN-assisted path, not TURN",()=>{
  const route=selectedIceRoute(stats(pair,{...local,candidateType:"srflx"},remote));
  expect(route.kind).toBe("stun");
  expect(route.label).toMatch(/STUN/);
});
test("unselected succeeded pairs cannot override explicitly selected transport pair",()=>{
  const transport={id:"transport",type:"transport",selectedCandidatePairId:"pair"};
  const decoy={...pair,id:"decoy",localCandidateId:"other",nominated:true};
  const route=selectedIceRoute(stats(decoy,{id:"other",type:"local-candidate",candidateType:"relay"},
    transport,pair,local,remote));
  expect(route.kind).toBe("direct");
});
test("no selected pair reports waiting rather than guessing STUN",()=>{
  expect(selectedIceRoute(stats(local,remote)).kind).toBe("pending");
});
test("relay-only option requires authenticated TURN ICE server",()=>{
  expect(hasTurnCredentials([{urls:"stun:example.com:3478"}])).toBe(false);
  expect(hasTurnCredentials([{urls:["turn:turn.example.com:3478?transport=udp"],
    username:"expiring:user",credential:"temporary"}])).toBe(true);
  expect(hasTurnCredentials([{urls:"turn:example.com:3478"}])).toBe(false);
});
test("temporary policy stays in session storage, not a permanent account preference",()=>{
  const data=new Map();
  const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  expect(readIcePolicy(storage)).toBe("all");
  expect(saveIcePolicy("relay",storage)).toBe("relay");
  expect(readIcePolicy(storage)).toBe("relay");
  expect(saveIcePolicy("bad",storage)).toBe("all");
});
