#!/usr/bin/env node
import {existsSync} from "node:fs";
import {readFile,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";
import {readProjectConfig,projectRunSummary} from "./project-config.js";
import {groupFindings} from "./findings.js";
import {controlCoverage} from "./control-coverage.js";

export function combineProjectReports(config,reports){
  const found=new Map(reports.map(r=>[r.name,r]));
  const missingScenarios=config.scenarios.filter(s=>!found.has(s.name)).map(s=>s.name);
  const summary=projectRunSummary(reports,config.screens);
  if(missingScenarios.length)summary.complete=false;
  return {project:config.name,summary,missingScenarios,
    findings:groupFindings(reports),coverage:controlCoverage(reports),
    scenarios:reports};
}
async function main(argv){
  const configPath=argv.includes("--config")?
    argv[argv.indexOf("--config")+1]:"tools/accesspilot/accesspilot.project.json";
  const dir=resolve(argv.includes("--output")?
    argv[argv.indexOf("--output")+1]:"accesspilot-report");
  const config=await readProjectConfig(configPath);
  const reports=[];
  for(const scenario of config.scenarios){
    const file=join(dir,scenario.name.replace(/[^a-zA-Z0-9_-]/g,"_")+".json");
    if(existsSync(file))reports.push(JSON.parse(await readFile(file,"utf8")));
  }
  const combined=combineProjectReports(config,reports);
  await writeFile(join(dir,"accesspilot-combined.json"),JSON.stringify(combined,null,2)+"\n");
  const lines=[
    "AccessPilot / "+config.name,
    "Сценариев: "+combined.summary.scenarios+
      "; экранов: "+combined.summary.states+
      "; нажатий: "+combined.summary.actions,
    "Проверено состояний доступности: "+combined.summary.auditedStates,
    "Непроверенных элементов: "+combined.summary.untested,
    "Завершён: "+(combined.summary.complete?"да":"нет"),
    "Не выполнены сценарии: "+(combined.missingScenarios.join(", ")||"нет"),
    "Уникальных ошибок: "+combined.findings.uniqueIssues,
    "Срабатываний проверок: "+combined.findings.occurrences,
    "Обнаружено DOM-элементов: "+combined.coverage.total,
    "Появлялись: "+combined.coverage.visible,
    "Нажимались: "+combined.coverage.attempted,
    "Сработали: "+combined.coverage.activated,
    "Никогда не появлялись: "+combined.coverage.neverVisible.length,
    "",
    ...combined.summary.screens.map(x=>
      (x.visited?"Проверен экран: ":"НЕ ПРОВЕРЕН экран: ")+x.name+" "+x.selector),
    "","ОШИБКИ:"
  ];
  for(const issue of combined.findings.groups){
    lines.push(issue.severity+" | "+issue.code+" | "+issue.selector,
      "Количество: "+issue.occurrences+"; экраны: "+issue.screens.join(", "),
      issue.message,JSON.stringify(issue.source??{}),"");
  }
  lines.push("","ВСЕ НЕПРОВЕРЕННЫЕ ЭЛЕМЕНТЫ:");
  for(const item of combined.coverage.untested)
    lines.push(item.selector+" | "+(item.visibleEver?"появлялся":"не появлялся"));
  await writeFile(join(dir,"accesspilot-combined.txt"),lines.join("\n")+"\n");
  console.log("ACCESSPILOT_COMBINED",JSON.stringify({
    ...combined.summary,missingScenarios:combined.missingScenarios,
    uniqueIssues:combined.findings.uniqueIssues,
    occurrences:combined.findings.occurrences
  }));
  return combined;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main(process.argv.slice(2)).catch(error=>{
    console.error("ACCESSPILOT_MERGE_ERROR",error?.stack||String(error));
    process.exitCode=1;
  });
}
