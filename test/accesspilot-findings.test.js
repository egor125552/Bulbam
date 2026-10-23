import {test,expect} from "vitest";
import {groupFindings} from "../tools/accesspilot/findings.js";

test("aggregates multiple distinct bugs, preserving every occurrence",()=>{
  const all=groupFindings([
    {name:"Чаты",findings:[
      {code:"wcag-list",selector:"#message-list",severity:"serious",screen:"Чаты"},
      {code:"wcag-list",selector:"#message-list",severity:"serious",screen:"Переписка"},
      {code:"wcag-label-content-name-mismatch",selector:"#voice-pause-button",severity:"serious",screen:"Переписка"},
      {code:"wcag-label-content-name-mismatch",selector:"#call-audio-cycle",severity:"serious",screen:"Звонок"}
    ]},
    {name:"Настройки",findings:[
      {code:"missing-name",element:"#save",severity:"moderate",screen:"Настройки"},
      {code:"wcag-list",selector:"#message-list",severity:"serious",screen:"Чаты"}
    ]}
  ]);
  expect(all.occurrences).toBe(6);
  expect(all.uniqueIssues).toBe(4);
  expect(all.bySeverity.serious).toBe(3);
  expect(all.bySeverity.moderate).toBe(1);
  expect(all.groups.find(issue=>issue.selector==="#message-list")).toMatchObject({
    occurrences:3,screens:["Чаты","Переписка"]
  });
  expect(all.groups.some(issue=>issue.selector==="#save"&&issue.code==="missing-name")).toBe(true);
});

test("returns a meaningful empty summary when no defects exist",()=>{
  expect(groupFindings([{name:"root",findings:[]}])).toMatchObject({
    occurrences:0,uniqueIssues:0,groups:[],
    bySeverity:{critical:0,serious:0,moderate:0,minor:0,unknown:0}
  });
});
