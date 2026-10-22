import { inspectBrowser, clickBrowser } from "./browser-engine.js";
import { auditAccessibility } from "./audit.js";
import {actionIdentity,missingActionCandidates} from "./action-coverage.js";

// Application-independent breadth-first exploration with durable checkpoints.
// Each queued task contains the button index so a resumed run does not repeat
// buttons that were already executed.
export async function crawlBrowser({
  page, reset, maxStates=45, maxActions=120, maxDepth=5, name="browser",
  onProgress=()=>{}, onCheckpoint=()=>{}, initialState=null, depthFirst=false,
  screenDescriptions=[]
}) {
  const queue=initialState?.queue ?? [{path:[],nextAction:0}];
  const visited=new Set(initialState?.visited ?? []);
  const screens=initialState?.screens ?? [];
  const actions=initialState?.actions ?? [];
  const findings=initialState?.findings ?? [];
  const issueKeys=new Set(initialState?.issueKeys ?? []);
  const unreachableActions=new Set(initialState?.unreachableActions ?? []);
  const auditedSignatures=new Set(initialState?.auditedSignatures ?? []);
  const completedActions=new Set(actions.map(action=>action.actionKey??
    actionIdentity(action,action.stateKey)));
  let truncated=false;
  const signature=state=>JSON.stringify(state.elements.map(el=>[
    el.selector,el.name,el.role,el.state,el.disabled,el.value
  ]));
  // Distinguish a new *screen structure* from a mere label/value change.
  // Otherwise translating the interface or typing into a form causes an
  // exponential number of logically identical routes.
  const graphKey=state=>JSON.stringify(state.elements.map(el=>[
    el.selector,el.role,el.kind,el.disabled
  ]));
  const checkpoint=()=>({
    version:4,queue,visited:[...visited],screens,actions,findings,issueKeys:[...issueKeys],
    unreachableActions:[...unreachableActions],auditedSignatures:[...auditedSignatures]
  });
  async function reach(path) {
    let failure=null;
    for(let attempt=0;attempt<3;attempt++){
      await reset();
      let ok=true;
      for(const step of path){
        const result=await clickBrowser(page,step);
        if(!result.ok){failure=result;ok=false;break;}
      }
      if(ok)return {ok:true};
      await page.waitForTimeout(150*(attempt+1));
    }
    return failure||{ok:false,reason:"unable to reproduce path"};
  }
  async function progress() {
    await onProgress({name,states:screens.length,actions:actions.length,
      pending:queue.length,findings:findings.length});
  }
  // The graph tracks structural routes; independent audits track every
  // distinct accessible name, role, value and state seen during interactions.
  async function auditState(state){
    const auditKey=signature(state);
    if(auditedSignatures.has(auditKey))return;
    auditedSignatures.add(auditKey);
    const violations=await auditAccessibility(page).catch(error=>[{
      code:"audit-failed",message:String(error?.message||error).slice(0,170)
    }]);
    for(const violation of violations){
      const itemKey=auditKey+"|"+violation.code+"|"+violation.selector;
      if(issueKeys.has(itemKey))continue;
      issueKeys.add(itemKey);
      findings.push({...violation,screen:state.title,source:null});
    }
    for(const issue of state.issues??[]){
      const itemKey=auditKey+"|"+issue.code+"|"+issue.element;
      if(issueKeys.has(itemKey))continue;
      issueKeys.add(itemKey);
      findings.push({...issue,screen:state.title});
    }
    for(const element of state.elements)for(const issue of element.issues){
      const itemKey=auditKey+"|"+element.selector+"|"+issue;
      if(issueKeys.has(itemKey))continue;
      issueKeys.add(itemKey);
      findings.push({code:issue,screen:state.title,element:element.selector,
        name:element.name,source:element.source});
    }
  }
  const priority=el=>el.role==="button"||el.role==="link"||el.role==="tab"?0:
    el.kind==="select"?1:el.kind==="click"?2:3;
  function missingActions(depth=maxDepth){
    return missingActionCandidates({screens,actions,maxDepth:depth,
      unreachableActions});
  }
  while(true){
    if(screens.length>=maxStates||actions.length>=maxActions){truncated=true;break;}
    if(!queue.length){
      const missing=missingActions();
      if(!missing.length)break;
      const {screen,target,actionKey}=missing[0];
      queue.push({path:screen.pathSteps??[],nextAction:0,onlySelector:target.selector,
        actionKey,expectedGraph:screen.stateKey??graphKey(screen),force:true});
    }
    const task=queue.shift(),path=task.path;
    let atNewChild=false;
    if(task.reuseCurrent){
      const current=await inspectBrowser(page);
      atNewChild=graphKey(current)===task.expectedGraph;
    }
    const reached=atNewChild?{ok:true}:await reach(path);
    if(!reached.ok){
      if(task.onlySelector)unreachableActions.add(task.actionKey??(task.expectedGraph+"|"+task.onlySelector));
      findings.push({code:"route-unreachable",path:path.map(el=>el.selector),reason:reached.reason});
      await onCheckpoint(checkpoint());
      continue;
    }
    let view=await inspectBrowser(page);
    // Network-backed transitions (calls, uploads, dialogs) can render their
    // final controls after click() resolves. Wait briefly for the exact
    // discovered target before deciding the saved state cannot be replayed.
    if(task.force&&task.onlySelector&&
        !view.elements.some(el=>el.selector===task.onlySelector)){
      try{
        await page.locator(task.onlySelector).first()
          .waitFor({state:"visible",timeout:2200});
      }catch{}
      view=await inspectBrowser(page);
    }
    const key=graphKey(view);
    await auditState(view);
    const firstVisit=!visited.has(key);
    if(!firstVisit&&task.nextAction===0&&!task.force)continue;
    if(firstVisit){
      visited.add(key);
      // Screen descriptions are observation-only labels, never action scripts.
      // A project may omit them entirely; exploration is still autonomous.
      const landmarks=await page.evaluate(descriptions=>descriptions.filter(item=>{
        try{
          const element=document.querySelector(item.selector);
          if(!element)return false;
          for(let p=element;p&&p.nodeType===1;p=p.parentElement){
            if(p.hidden||p.inert||p.getAttribute("aria-hidden")==="true")return false;
            const style=getComputedStyle(p);
            if(style.display==="none"||style.visibility==="hidden")return false;
          }
          return element.getClientRects().length>0;
        }catch{return false;}
      }).map(item=>item.name),screenDescriptions);
      const accessibilityTree=await page.locator("body").ariaSnapshot({timeout:3000}).catch(()=>null);
      screens.push({name:view.title,stateKey:key,path:path.map(el=>el.selector),pathSteps:path,
        elements:view.elements,inventory:view.inventory,
        focus:view.focus,announcements:view.announcements,
        landmarks,accessibilityTree});
    }
    if(path.length>=maxDepth){
      await progress();
      await onCheckpoint(checkpoint());
      continue;
    }
    const targets=[...view.elements].sort((a,b)=>priority(a)-priority(b));
    // An unrelated control or banner may have changed since this screen
    // was first discovered. If our target still exists, try the actual
    // control instead of requiring an identical complete DOM snapshot.
    if(task.force&&!targets.some(target=>target.selector===task.onlySelector)){
      unreachableActions.add(task.actionKey??(task.expectedGraph+"|"+task.onlySelector));
      findings.push({code:"state-unavailable",screen:view.title,
        element:task.onlySelector,message:"Target control is no longer reachable"});
      continue;
    }
    let paused=false;
    let descended=false;
    // A returned parent can have acquired new controls asynchronously.
    // In that case inspect the newly discovered structure from its first
    // control rather than reusing an index from the old structure.
    for(let index=firstVisit?0:task.nextAction;index<targets.length;index++){
      if(actions.length>=maxActions){
        queue.unshift({path,nextAction:index});
        truncated=true;
        paused=true;
        break;
      }
      const target=targets[index];
      if(task.onlySelector&&target.selector!==task.onlySelector)continue;
      const actionKey=actionIdentity(target,key);
      // Replays may land on the same selector in a DIFFERENT local state.
      // Requeueing the old action forever makes pending counts meaningless.
      if(task.force&&task.actionKey&&actionKey!==task.actionKey){
        unreachableActions.add(task.actionKey);
        findings.push({code:"state-unavailable",screen:view.title,
          element:target.selector,reason:"Local action state changed on replay"});
        break;
      }
      if(completedActions.has(actionKey))continue;
      let before=await inspectBrowser(page);
      if(graphKey(before)!==key){
        const restored=await reach(path);
        if(!restored.ok){
          findings.push({code:"route-unreachable-before-action",
            screen:view.title,element:target.selector,reason:restored.reason});
          continue;
        }
        before=await inspectBrowser(page);
      }
      const apiResponses=[],jsExceptions=[];
      const observe=response=>{
        try{
          const path=new URL(response.url()).pathname;
          apiResponses.push({status:response.status(),path,
            method:response.request().method(),type:response.request().resourceType()});
        }catch{}
      };
      const observeError=error=>jsExceptions.push(String(error?.stack||error).slice(0,1200));
      page.on("response",observe);
      page.on("pageerror",observeError);
      let result;
      try{
        result=await clickBrowser(page,target);
        await page.waitForTimeout(180);
      }finally{
        page.off("response",observe);
        page.off("pageerror",observeError);
      }
      const after=await inspectBrowser(page);
      await auditState(after);
      for(const response of apiResponses.filter(r=>r.status>=500)){
        findings.push({code:"http-server-error",severity:"serious",
          screen:view.title,selector:target.selector,source:target.source,
          message:response.method+" "+response.path+" returned HTTP "+response.status});
      }
      for(const message of jsExceptions){
        findings.push({code:"javascript-error",severity:"serious",
          screen:view.title,selector:target.selector,source:target.source,
          message});
      }
      const changed=signature(before)!==signature(after)
        ||JSON.stringify(before.announcements)!==JSON.stringify(after.announcements);
      if(result.ok&&after.focus&&!after.focus.visible)
        findings.push({code:"focus-hidden-after-action",screen:view.title,
          element:target.selector,name:target.name,focus:after.focus,source:target.source});
      actions.push({screen:view.title,stateKey:task.force?task.expectedGraph:key,
        actionKey,selector:target.selector,name:target.name,
        kind:target.kind,success:result.ok,changed,reason:result.reason??null,
        apiResponses,announcements:after.announcements,after:after.title,
        focus:after.focus,source:target.source});
      completedActions.add(actionKey);
      const shape=state=>JSON.stringify(state.elements.map(el=>[el.selector,el.role,el.name,el.disabled]));
      if(result.ok&&shape(before)!==shape(after)&&!visited.has(graphKey(after))){
        if(depthFirst){
          queue.unshift({path,nextAction:index+1});
          queue.unshift({path:[...path,target],nextAction:0,
            reuseCurrent:true,expectedGraph:graphKey(after)});
          descended=true;
        }else{
          queue.push({path:[...path,target],nextAction:0});
        }
      }
      if(actions.length%10===0){
        await progress();
        await onCheckpoint(descended?checkpoint():{
          ...checkpoint(),queue:[{path,nextAction:index+1},...queue]
        });
      }
      if(descended||task.force)break;
    }
    await progress();
    await onCheckpoint(checkpoint());
    if(paused)break;
  }
  const blockedRoutes=findings.filter(f=>f.code==="route-unreachable"||
    f.code==="route-unreachable-before-action"||f.code==="state-unavailable").length;
  const allMissing=missingActions(Infinity);
  const untested=allMissing.length+unreachableActions.size;
  const depthLimited=allMissing.filter(item=>item.screen.path.length>=maxDepth).length;
  return {
    name,screens,actions,findings,checkpoint:checkpoint(),
    summary:{screens:screens.length,actions:actions.length,blockedRoutes,untested,
      complete:!truncated&&blockedRoutes===0&&untested===0,
      auditedStates:auditedSignatures.size,
      elements:screens.reduce((n,screen)=>n+screen.elements.length,0),
      issues:findings.length,changed:actions.filter(action=>action.changed).length,
      truncated,pending:queue.length,depthLimited}
  };
}
