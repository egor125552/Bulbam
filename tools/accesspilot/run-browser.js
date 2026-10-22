#!/usr/bin/env node
import { launchHeadless } from "./browser-launch.js";
import { mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { launchBulbamTestHost } from "./browser-host.js";
import { crawlBrowser } from "./crawler.js";
import { installSourceTracking } from "./browser-instrumentation.js";
import { installAccessibilityAudit } from "./audit.js";
import { measureStaticCoverage } from "./coverage.js";
const host=await launchBulbamTestHost();
let browser;
const reports=[];
const sourceHTML=readFileSync(resolve("web/index.html"),"utf8");
function sourceLine(selector){
  if(!selector.startsWith("#")||selector.includes(" "))return null;
  const id=selector.slice(1);
  const escaped=id.replace(/[^a-zA-Z0-9_-]/g,'\\$&');
  const pattern=new RegExp("<[a-z][^>]*\\bid=[\"']"+escaped+"[\"'][^>]*>","gi");
  const locations=[...sourceHTML.matchAll(pattern)];
  return locations.length===1?{file:"web/index.html",line:sourceHTML.slice(0,locations[0].index).split("\n").length}:null;
}
function addOrigins(result){
  for(const screen of result.screens){
    for(const element of screen.elements){
      element.source={...element.source,markup:sourceLine(element.selector)};
    }
  }
  for(const action of result.actions)action.source={...action.source,markup:sourceLine(action.selector)};
  for(const finding of result.findings)finding.source={...finding.source,markup:sourceLine(finding.element||"")};
}
try{
  browser=await launchHeadless();
  const requested=(process.env.ACCESSPILOT_SCENARIOS||"signed-out,signed-in").split(",");
  for(const signedIn of [false,true].filter(value=>requested.includes(value?"signed-in":"signed-out"))){
    const mobile=process.env.ACCESSPILOT_MOBILE==="1";
    const context=await browser.newContext({serviceWorkers:"block",
      permissions:process.env.ACCESSPILOT_FAKE_MEDIA==="1"?["microphone"]:[],
      ...(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{})});
    await context.addInitScript(installSourceTracking);
    await installAccessibilityAudit(context);
    await context.addInitScript(userId=>localStorage.setItem("bulbam.welcome.v1."+userId,"yes"),host.account.userId);
    if(signedIn)await context.addCookies([{name:"bulbam_session",value:host.cookie,url:host.baseURL,httpOnly:true,sameSite:"Lax"}]);
    const page=await context.newPage();
    await page.route("**/*",route=>route.request().url().startsWith(host.baseURL)?route.continue():route.abort());
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    // Accept only prompts produced inside the disposable isolated test worker.
    page.on("dialog",dialog=>dialog.accept("AccessPilot test").catch(()=>{}));
    async function reset(){
      await page.goto(host.baseURL,{waitUntil:"domcontentloaded",timeout:8000});
      await page.waitForFunction(() => {
        const logged = document.getElementById("signed-in");
        const loggedOut = document.getElementById("signed-out");
        return (logged && !logged.hidden) || (loggedOut && !loggedOut.hidden);
      },{timeout:9000}).catch(()=>{});
      await page.waitForTimeout(150);
      if(signedIn && await page.locator("#signed-in").isHidden()) {
        // The previous action may have ended the disposable test session.
        // Restore only when needed, not after every button.
        const token=await host.issueSession();
        await context.addCookies([{name:"bulbam_session",value:token,url:host.baseURL,
          httpOnly:true,sameSite:"Lax"}]);
        await page.reload({waitUntil:"domcontentloaded",timeout:8000});
        await page.waitForFunction(()=>!document.getElementById("signed-in")?.hidden,{timeout:7000}).catch(()=>{});
      }
      if(signedIn && host.readySelector){
        await page.locator(host.readySelector).first().waitFor({
          state:"attached",timeout:5000
        }).catch(()=>{});
      }
    }
    const exhaustive=process.env.ACCESSPILOT_EXHAUSTIVE==="1";
    const depthFirst=process.env.ACCESSPILOT_BREADTH_FIRST!=="1";
    const checkpointPath=resolve("accesspilot-report",`checkpoint-${mobile?"mobile":"desktop"}-${signedIn?"signed-in":"signed-out"}-${depthFirst?"dfs":"bfs"}.json`);
    const initialState=process.env.ACCESSPILOT_RESUME==="1"&&existsSync(checkpointPath)
      ? JSON.parse(readFileSync(checkpointPath,"utf8")):null;
    const batch=Number(process.env.ACCESSPILOT_BATCH_ACTIONS||0);
    const actionCap=batch?(initialState?.actions.length||0)+batch
      :Number(process.env.ACCESSPILOT_MAX_ACTIONS||(exhaustive?1200:150));
    const result=await crawlBrowser({
      page,reset,name:signedIn?"Вход выполнен":"Экран входа",
      maxStates:Number(process.env.ACCESSPILOT_MAX_STATES||(exhaustive?200:55)),
      maxActions:actionCap,
      depthFirst,
      initialState,
      onCheckpoint:checkpoint=>{
        mkdirSync("accesspilot-report",{recursive:true});
        writeFileSync(checkpointPath,JSON.stringify(checkpoint));
      },
      maxDepth:exhaustive?12:5,
      onProgress:({name,states,actions,pending,findings})=>{
        console.log(JSON.stringify({phase:'progress',name,states,actions,pending,findings}));
      }
    });
    result.errors=errors;
    if(result.summary.complete&&existsSync(checkpointPath))unlinkSync(checkpointPath);
    addOrigins(result);
    reports.push(result);
    console.log(result.name,result.summary, result.findings.slice(0,15));
    await context.close();
  }
}finally{
  if(browser)await browser.close();
  await host.close();
}
mkdirSync("accesspilot-report",{recursive:true});
const resultTag=process.env.ACCESSPILOT_SCENARIOS?"-"+process.env.ACCESSPILOT_SCENARIOS.replace(/[^a-z,-]/g,""):"";
writeFileSync(resolve("accesspilot-report","Полный отчёт браузерного тестирования Бульбама"+resultTag+".json"),JSON.stringify(reports,null,2));
const coverage=measureStaticCoverage(sourceHTML,reports);
writeFileSync(resolve("accesspilot-report","Покрытие элементов Бульбама"+resultTag+".json"),JSON.stringify(coverage,null,2));
const lines=["AccessPilot. Реальный браузер Chromium, изолированная тестовая база, без реального VoiceOver."];
for(const report of reports){
 lines.push("Сценарий: "+report.name,JSON.stringify(report.summary),"Проблемы:");
 lines.push(...report.findings.map(f=>JSON.stringify(f)));
 lines.push("Кнопки и действия:",...report.actions.map(a=>[
  a.screen,a.name,a.kind,a.success?"нажато":"не выполнено",a.changed?"состояние изменилось":"без изменения",a.reason||""
 ].join(" | ")));
}
lines.push("", "ПОКРЫТИЕ СТАТИЧЕСКИХ ЭЛЕМЕНТОВ:",
  "Всего: "+coverage.totalStaticControls,
  "Показано в исследованных экранах: "+coverage.rendered,
  "Вызвано действие: "+coverage.activated,
  "Ещё не выполнены (не обязательно ошибки):");
for(const item of coverage.notActivated)lines.push(item.file+":"+item.line+" | "+item.tag+" #"+item.id);
writeFileSync(resolve("accesspilot-report","Полный отчёт браузерного тестирования Бульбама"+resultTag+".txt"),lines.join("\n"));
