import {describe,it,expect} from "vitest";
import {normalizeProjectConfig,projectRunSummary,resolveProjectProvider} from "../tools/accesspilot/project-config.js";

describe("generic project manifest",()=>{
  it("works for an unrelated application with no button-specific instructions",()=>{
    const project=normalizeProjectConfig({
      version:1,name:"Invented application",url:"http://127.0.0.1:9315",
      mode:"explore",screens:[{name:"Library",selector:"#library"}],
      scenarios:[{name:"anonymous",profile:"guest",ready:"main"}],
      limits:{maxActions:40,maxStates:12}
    },"/tmp/sample/accesspilot.json");
    expect(project.screens).toEqual([{name:"Library",selector:"#library"}]);
    expect(project.limits.maxDepth).toBe(7);
    expect(resolveProjectProvider(project)).toBeNull();
  });
  it("does not permit writing actions on unknown external production websites",()=>{
    expect(()=>normalizeProjectConfig({version:1,name:"unsafe",url:"https://example.com",mode:"explore"})).toThrow("audit-only");
    expect(normalizeProjectConfig({version:1,name:"read only",url:"https://example.com"}).mode).toBe("audit");
  });
  it("validates the environment boundary without defining click handlers",()=>{
    const config=normalizeProjectConfig({version:1,name:"Demo",provider:"./fixture-provider.js",
      scenarios:[{name:"logged-in",profile:"user"}]},"/tmp/x/project.json");
    expect(resolveProjectProvider(config)).toBe("file:///tmp/x/fixture-provider.js");
    expect(config.mode).toBe("explore");
    expect(()=>normalizeProjectConfig({version:1,name:"bad",provider:"node:fs"})).toThrow("relative");
  });
  it("shows visited and still-missing declared screens, never claiming unsupported completeness",()=>{
    const report={summary:{screens:2,actions:5,auditedStates:3,untested:2,complete:false},
      screens:[{landmarks:["Home"]},{landmarks:["Settings"]}]};
    expect(projectRunSummary([report],[{name:"Home",selector:"#home"},
      {name:"Settings",selector:"#settings"},{name:"Calls",selector:"#calls"}]))
      .toMatchObject({states:2,actions:5,untested:2,complete:false,
        screens:[{visited:true},{visited:true},{visited:false}]});
  });
});
