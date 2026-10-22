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
