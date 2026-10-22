import {mkdir,readFile,rename,rm,writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";
import {launchHeadless} from "./browser-launch.js";
import {inspectBrowser} from "./browser-engine.js";
import {crawlBrowser} from "./crawler.js";
import {auditAccessibility,installAccessibilityAudit} from "./audit.js";
import {installSourceTracking} from "./browser-instrumentation.js";
import {groupFindings} from "./findings.js";
import {controlCoverage} from "./control-coverage.js";
import {projectRunSummary,resolveProjectProvider} from "./project-config.js";

const safeFile=name=>name.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,90);
const isLocal=url=>["127.0.0.1","localhost","[::1]"].includes(new URL(url).hostname);
async function saveJSON(path,data) {
  await mkdir(resolve(path,".."),{recursive:true});
  const tmp=path+".tmp";
  await writeFile(tmp,JSON.stringify(data,null,2)+"\n");
  await rename(tmp,path);
}
async function observedLandmarks(page,screens){
  return page.evaluate(items=>items.filter(item=>{
    try{
      const node=document.querySelector(item.selector);
      if(!node||!node.getClientRects().length)return false;
      for(let current=node;current;current=current.parentElement){
        if(current.hidden||current.inert||current.getAttribute("aria-hidden")==="true")return false;
        const style=getComputedStyle(current);
        if(style.display==="none"||style.visibility==="hidden")return false;
      }
      return true;
    }catch{return false;}
  }).map(item=>item.name),screens);
}
async function auditOnly(page,config,scenario){
  const view=await inspectBrowser(page);
  const landmarks=await observedLandmarks(page,config.screens);
  const violations=await auditAccessibility(page);
  return {name:scenario.name,actions:[],findings:[
    ...violations.map(issue=>({...issue,screen:view.title})),
    ...(view.issues??[]).map(issue=>({...issue,screen:view.title})),
    ...view.elements.flatMap(element=>element.issues.map(code=>({
      code,screen:view.title,element:element.selector,source:element.source
    })))
  ],screens:[{name:view.title,landmarks,elements:view.elements,
    inventory:view.inventory,focus:view.focus,
    accessibilityTree:await page.locator("body").ariaSnapshot()}],
    summary:{screens:1,actions:0,issues:violations.length,untested:view.elements.length,
      auditedStates:1,complete:false,truncated:false,pending:0,blockedRoutes:0}};
}
function reportText(config,report){
  const lines=[
    "AccessPilot | "+config.name,
    "Режим: "+config.mode+". Тестирование проводится в Chromium, не в VoiceOver.",
    "Состояний: "+report.summary.states+". Действий: "+report.summary.actions+
      ". Проверенных доступных состояний: "+report.summary.auditedStates,
    "Непроверенных действий: "+report.summary.untested+
      ". Завершён: "+(report.summary.complete?"да":"нет"),
    "Уникальных проблем: "+report.findings.uniqueIssues+
      ". Срабатываний проверок: "+report.findings.occurrences,
    "Всего обнаружено элементов в DOM: "+report.coverage.total,
    "Хотя бы раз появлялись: "+report.coverage.visible,
    "Были доступны скринридеру: "+report.coverage.exposed,
    "Попытка действия: "+report.coverage.attempted,
    "Успешно активированы: "+report.coverage.activated,
    "Ни разу не появились: "+report.coverage.neverVisible.length,"",
    "ОПИСАННЫЕ ЭКРАНЫ:"
  ];
  for(const s of report.summary.screens)
    lines.push((s.visited?"[достигнут] ":"[НЕ ДОСТИГНУТ] ")+s.name+" ("+s.selector+")");
  lines.push("","ВСЕ ПРОБЛЕМЫ:");
  for(const item of report.findings.groups){
    lines.push(item.severity+" | "+item.code+" | "+item.selector,
      "  Повторы: "+item.occurrences+"; экраны: "+item.screens.join(", "),
      "  "+item.message,"  "+JSON.stringify(item.source??{}));
  }
  lines.push("","ОБНАРУЖЕННЫЕ, НО НЕ ПРОВЕРЕННЫЕ ЭЛЕМЕНТЫ:");
  for(const item of report.coverage.untested)
    lines.push(item.selector+" | "+item.name+" | "+
      (item.visibleEver?"видимый":"не появлялся"));
  lines.push("","РЕАЛЬНЫЕ ДЕЙСТВИЯ:");
  for(const r of report.scenarios){
    lines.push("СЦЕНАРИЙ "+r.name+": "+JSON.stringify(r.summary));
    for(const a of r.actions)
      lines.push((a.success?"выполнено":"НЕ ВЫПОЛНЕНО")+" | "+a.selector+
        " | "+a.name+" | "+(a.changed?"интерфейс изменился":"нет видимого изменения")+
        " | "+(a.reason??""));
  }
  return lines.join("\n")+"\n";
}

/**
 * Provider contract (environment fixture, not a button script):
 * createEnvironment(config) -> {url, isolated, allowedOrigins?, prepare?,
 * reset?, close?}. prepare({context,scenario}) installs ephemeral cookies.
 * reset({page,context,scenario,url}) returns after its app is ready.
 */
export async function runProject(config,{
  scenarioNames=null,outputDir=null,resume=false,logger=console
}={}){
  const moduleURL=resolveProjectProvider(config);
  const provider=moduleURL?await import(moduleURL):null;
  if(provider&&typeof provider.createEnvironment!=="function")
    throw new Error("AccessPilot provider needs createEnvironment(config)");
  const environment=provider?await provider.createEnvironment(config):{
    url:config.url,isolated:false
  };
  if(!environment||typeof environment.url!=="string")
    throw new Error("AccessPilot provider did not supply url");
  if(config.mode==="explore"&&!isLocal(environment.url)&&!environment.isolated)
    throw new Error("AccessPilot refuses to interact with a non-isolated remote app");
  const allowed=new Set([new URL(environment.url).origin,...(environment.allowedOrigins??[])]);
  const selected=config.scenarios.filter(s=>!scenarioNames||scenarioNames.includes(s.name));
  if(!selected.length)throw new Error("AccessPilot: no matching scenarios selected");
  const dir=resolve(outputDir??join(config.directory,"accesspilot-report"));
  await mkdir(dir,{recursive:true});
  let browser;
  const reports=[];
  try{
    browser=await launchHeadless();
    for(const scenario of selected){
      const context=await browser.newContext({
        serviceWorkers:"block",permissions:scenario.permissions,acceptDownloads:false
      });
      try{
        await context.addInitScript(installSourceTracking);
        await installAccessibilityAudit(context);
        if(environment.prepare)await environment.prepare({context,scenario});
        const page=await context.newPage();
        // Prevent the tested application from touching production or third
        // party services unless the fixture explicitly permits their origin.
        await page.route("**/*",route=>{
          const url=route.request().url();
          let origin;
          try{origin=new URL(url).origin;}catch{return route.abort();}
          return allowed.has(origin)?route.continue():route.abort();
        });
        page.on("dialog",dialog=>dialog.dismiss().catch(()=>{}));
        const errors=[];
        page.on("pageerror",error=>errors.push(error.message));
        const reset=async()=>{
          if(environment.reset) {
            await environment.reset({page,context,scenario,url:environment.url});
          }else{
            await page.goto(environment.url,{waitUntil:"domcontentloaded",timeout:15000});
            if(scenario.ready)await page.locator(scenario.ready)
              .first().waitFor({state:"visible",timeout:10000});
          }
        };
        const filename=safeFile(scenario.name);
        const checkpointFile=join(dir,filename+".checkpoint.json");
        let initialState=null;
        if(resume&&existsSync(checkpointFile)){
          initialState=JSON.parse(await readFile(checkpointFile,"utf8"));
        }
        let result;
        try{
          await reset();
          if(config.mode==="explore"){
            const cap=Number(process.env.ACCESSPILOT_MAX_ACTIONS)||config.limits.maxActions;
            result=await crawlBrowser({
              page,reset,name:scenario.name,
              maxActions:resume&&initialState?initialState.actions.length+cap:cap,
              maxStates:Number(process.env.ACCESSPILOT_MAX_STATES)||config.limits.maxStates,
              maxDepth:config.limits.maxDepth,
              depthFirst:true,
              screenDescriptions:config.screens,
              initialState,
              onProgress:progress=>logger.log("ACCESSPILOT_PROGRESS",JSON.stringify(progress)),
              onCheckpoint:state=>saveJSON(checkpointFile,state)
            });
          }else result=await auditOnly(page,config,scenario);
        }catch(error){
          result={name:scenario.name,screens:[],actions:[],findings:[{
            code:"scenario-failed",severity:"critical",screen:scenario.name,
            message:String(error?.stack||error)
          }],summary:{screens:0,actions:0,issues:1,untested:0,
            auditedStates:0,complete:false,truncated:true,pending:0,blockedRoutes:1}};
        }
        for(const message of errors)result.findings.push({
          code:"javascript-error",severity:"serious",screen:scenario.name,message
        });
        if(result.summary.complete&&existsSync(checkpointFile))await rm(checkpointFile);
        reports.push(result);
        await saveJSON(join(dir,filename+".json"),result);
        logger.log("ACCESSPILOT_SCENARIO",JSON.stringify({
          name:scenario.name,...result.summary,findings:result.findings.length
        }));
      }finally{await context.close();}
    }
    const findings=groupFindings(reports);
    const summary=projectRunSummary(reports,config.screens);
    const coverage=controlCoverage(reports);
    const all={project:config.name,mode:config.mode,summary,findings,
      coverage,scenarios:reports};
    await saveJSON(join(dir,"accesspilot-report.json"),all);
    await writeFile(join(dir,"accesspilot-report.txt"),reportText(config,all));
    logger.log("ACCESSPILOT_RESULT",JSON.stringify({
      ...summary,uniqueIssues:findings.uniqueIssues,
      occurrences:findings.occurrences,
      controls:coverage.total,activated:coverage.activated,
      neverVisible:coverage.neverVisible.length
    }));
    return all;
  }finally{
    if(browser)await browser.close();
    if(environment.close)await environment.close();
  }
}
