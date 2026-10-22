import {test,expect} from "vitest";
import {normalizeProjectConfig} from "../tools/accesspilot/project-config.js";
import {combineProjectReports} from "../tools/accesspilot/merge-reports.js";

test("combines all routes and failures without mistaking missing scenarios for full coverage",()=>{
  const config=normalizeProjectConfig({version:1,name:"Unknown app",url:"http://localhost:3000",
    scenarios:[{name:"public",profile:"guest"},{name:"private",profile:"user"}],
    screens:[{name:"Home",selector:"main"},{name:"Account",selector:"#account"}]
  });
  const partial=combineProjectReports(config,[{
    name:"public",screens:[{landmarks:["Home"]}],
    actions:[{selector:"#open"}],
    findings:[{code:"wcag-label",selector:"#input",screen:"Home",severity:"serious"}],
    summary:{screens:1,actions:1,auditedStates:1,complete:true,untested:0}
  }]);
  expect(partial.missingScenarios).toEqual(["private"]);
  expect(partial.summary.complete).toBe(false);
  expect(partial.findings.uniqueIssues).toBe(1);
  expect(partial.summary.screens[1].visited).toBe(false);
});
