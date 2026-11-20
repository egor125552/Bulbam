import {test,expect} from "vitest";
import {controlCoverage} from "../tools/accesspilot/control-coverage.js";

test("never-visible elements are explicitly reported separately from failed clicks",()=>{
 const result=controlCoverage([{
   screens:[{inventory:[
     {selector:"#open",name:"Open",role:"button",visible:true,exposed:true},
     {selector:"#answer",name:"Answer",role:"button",visible:false,exposed:false},
     {selector:"#locked",name:"Locked",role:"button",visible:true,exposed:true}
   ]}],
   actions:[{selector:"#open",success:true},{selector:"#locked",success:false}]
 }]);
 expect(result.total).toBe(3);
 expect(result.visible).toBe(2);
 expect(result.attempted).toBe(2);
 expect(result.activated).toBe(1);
 expect(result.neverVisible.map(x=>x.selector)).toEqual(["#answer"]);
 expect(result.failed.map(x=>x.selector)).toEqual(["#locked"]);
 expect(result.untested.map(x=>x.selector)).toEqual(["#answer"]);
});

test("read-only recovery information is classified separately from untested controls",()=>{
  const result=controlCoverage([{
    screens:[{inventory:[
      {selector:"#recovery-codes-text",role:"textbox",visible:true,exposed:true,readOnly:true},
      {selector:"#editable",role:"textbox",visible:true,exposed:true,readOnly:false},
      {selector:"#hidden",role:"button",visible:false,exposed:false}
    ]}],actions:[]
  }]);
  expect(result.readOnly.map(x=>x.selector)).toEqual(["#recovery-codes-text"]);
  expect(result.untested.map(x=>x.selector)).toEqual(["#editable","#hidden"]);
  expect(result.total).toBe(3);
});
