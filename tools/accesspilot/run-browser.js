#!/usr/bin/env node
import { launchHeadless } from "./browser-launch.js";
import { mkdirSync,writeFileSync,readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchBulbamTestHost } from "./browser-host.js";
import { crawlBrowser } from "./browser-engine.js";
import { installSourceTracking } from "./browser-instrumentation.js";
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
  for(const signedIn of [false,true]){
    const mobile=process.env.ACCESSPILOT_MOBILE==="1";
    const context=await browser.newContext({serviceWorkers:"block",permissions:[],
      ...(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{})});
    await context.addInitScript(installSourceTracking);
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
    }
    const exhaustive=process.env.ACCESSPILOT_EXHAUSTIVE==="1";
    const result=await crawlBrowser({
      page,reset,name:signedIn?"Вход выполнен":"Экран входа",
      maxStates:Number(process.env.ACCESSPILOT_MAX_STATES||(exhaustive?200:55)),
      maxActions:Number(process.env.ACCESSPILOT_MAX_ACTIONS||(exhaustive?1200:150)),
      maxDepth:exhaustive?12:5
    });
    result.errors=errors;
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
writeFileSync(resolve("accesspilot-report","Полный отчёт браузерного тестирования Бульбама.json"),JSON.stringify(reports,null,2));
const lines=["AccessPilot. Реальный браузер Chromium, изолированная тестовая база, без реального VoiceOver."];
for(const report of reports){
 lines.push("Сценарий: "+report.name,JSON.stringify(report.summary),"Проблемы:");
 lines.push(...report.findings.map(f=>JSON.stringify(f)));
 lines.push("Кнопки и действия:",...report.actions.map(a=>[
  a.screen,a.name,a.kind,a.success?"нажато":"не выполнено",a.changed?"состояние изменилось":"без изменения",a.reason||""
 ].join(" | ")));
}
writeFileSync(resolve("accesspilot-report","Полный отчёт браузерного тестирования Бульбама.txt"),lines.join("\n"));
