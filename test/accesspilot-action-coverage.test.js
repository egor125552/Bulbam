import {test,expect} from "vitest";
import {actionIdentity,missingActionCandidates} from "../tools/accesspilot/action-coverage.js";

const target=(selector,scopeKey,state="")=>({
  selector,scopeKey,role:"button",kind:"click",state,disabled:false
});
const screen=(stateKey,els)=>({
  stateKey, path:[], pathSteps:[], elements:els
});

test("same navigation action is tested once across unrelated chat states",()=>{
  const settings=target("#settings-button","sidebar|#new-chat-button,#settings-button");
  const one=screen("chat without draft",[settings]);
  const two=screen("chat with draft",[settings]);
  const id=actionIdentity(settings,one.stateKey);
  const missing=missingActionCandidates({
    screens:[one,two],actions:[{stateKey:one.stateKey,selector:settings.selector,actionKey:id}],
    maxDepth:10
  });
  expect(missing).toEqual([]);
});

test("separate local scopes and changed action states remain independently testable",()=>{
  const nav=target("#settings-button","sidebar|#settings-button");
  const dialog=target("#settings-button","modal|#settings-button,#save");
  const toggleOn=target("#toggle","panel|#toggle","true");
  const toggleOff=target("#toggle","panel|#toggle","false");
  expect(actionIdentity(nav,"a")).not.toBe(actionIdentity(dialog,"b"));
  expect(actionIdentity(toggleOn,"a")).not.toBe(actionIdentity(toggleOff,"b"));
});

test("unvisited local controls remain pending but are not counted repeatedly",()=>{
  const nav=target("#settings-button","sidebar|#settings-button");
  const unique=target("#delete-draft","composer|#delete-draft");
  const screens=[screen("one",[nav]),screen("two",[nav,unique]),screen("three",[nav,unique])];
  const missing=missingActionCandidates({screens,actions:[],maxDepth:10});
  expect(missing.map(item=>item.target.selector)).toEqual(["#settings-button","#delete-draft"]);
});

test("disabled controls do not count as actionable coverage debt",()=>{
  const disabled={...target("#locked","group|#locked"),disabled:true};
  expect(missingActionCandidates({screens:[screen("a",[disabled])],actions:[],maxDepth:10})).toEqual([]);
});

test("read-only textareas are content, not failed editable actions",()=>{
  const readOnly={...target("#codes","panel|#codes"),
    role:"textbox",kind:"fill",readOnly:true};
  expect(missingActionCandidates({screens:[screen("codes",[readOnly])],
    actions:[],maxDepth:10})).toEqual([]);
});
