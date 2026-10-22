import {test,expect,vi} from "vitest";

vi.mock("../tools/accesspilot/browser-engine.js",()=>({
  inspectBrowser:vi.fn(async()=>({
    title:"Mock application",
    elements:[{selector:"#open",name:"Open",role:"button",kind:"click",
      scopeKey:"new local context",state:"",disabled:false,issues:[]}],
    issues:[],announcements:[],focus:null,inventory:[]
  })),
  clickBrowser:vi.fn(async()=>({ok:true}))
}));
vi.mock("../tools/accesspilot/audit.js",()=>({
  auditAccessibility:vi.fn(async()=>[])
}));

import {crawlBrowser} from "../tools/accesspilot/crawler.js";
import {inspectBrowser} from "../tools/accesspilot/browser-engine.js";

test("a stale replay is marked unreachable rather than retried forever",async()=>{
  const element={selector:"#open",name:"Open",role:"button",kind:"click",
    scopeKey:"previous local context",state:"",disabled:false,issues:[]};
  const graphKey=JSON.stringify([[element.selector,element.role,element.kind,false]]);
  let progress=0;
  const result=await crawlBrowser({
    page:{waitForTimeout:async()=>{}},
    reset:async()=>{},
    initialState:{
      version:4,queue:[],visited:[graphKey],
      screens:[{name:"Initial",stateKey:graphKey,path:[],pathSteps:[],
        elements:[element],inventory:[]}],
      actions:[],findings:[],issueKeys:[],unreachableActions:[],
      auditedSignatures:[]
    },
    maxActions:15,maxStates:12,maxDepth:4,
    onProgress:()=>{if(++progress>6)throw Error("Replayed the same action indefinitely");}
  });
  expect(result.summary.complete).toBe(false);
  expect(result.summary.blockedRoutes).toBeGreaterThan(0);
  expect(result.checkpoint.unreachableActions).toHaveLength(1);
  expect(result.actions).toHaveLength(0);
});

test("late controls are awaited during replay instead of silently skipped",async()=>{
  const element={selector:"#late",name:"Late action",role:"button",
    kind:"click",scopeKey:"stable modal",state:"",disabled:false,issues:[]};
  const graphKey=JSON.stringify([[element.selector,element.role,element.kind,false]]);
  let ready=false;
  vi.mocked(inspectBrowser).mockImplementation(async()=>({
    title:"Async app",elements:ready?[element]:[],issues:[],
    announcements:[],focus:null,inventory:[]
  }));
  const result=await crawlBrowser({
    page:{
      waitForTimeout:async()=>{},
      on:()=>{},off:()=>{},
      locator:()=>({first:()=>({waitFor:async()=>{ready=true;}})})
    },
    reset:async()=>{},
    initialState:{
      version:4,queue:[],visited:[graphKey],
      screens:[{name:"Previous",stateKey:graphKey,path:[],pathSteps:[],
        elements:[element],inventory:[]}],
      actions:[],findings:[],issueKeys:[],unreachableActions:[],
      auditedSignatures:[]
    },
    maxActions:10,maxStates:10,maxDepth:3
  });
  expect(result.actions.map(action=>action.selector)).toEqual(["#late"]);
  expect(result.summary.untested).toBe(0);
  expect(result.summary.complete).toBe(true);
});
