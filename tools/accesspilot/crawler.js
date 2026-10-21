import { inspectBrowser, clickBrowser } from "./browser-engine.js";

// Application-independent breadth-first exploration with durable checkpoints.
// Each queued task contains the button index so a resumed run does not repeat
// buttons that were already executed.
export async function crawlBrowser({
  page, reset, maxStates=45, maxActions=120, maxDepth=5, name="browser",
  onProgress=()=>{}, onCheckpoint=()=>{}, initialState=null, depthFirst=false
}) {
  const queue=initialState?.queue ?? [{path:[],nextAction:0}];
  const visited=new Set(initialState?.visited ?? []);
  const screens=initialState?.screens ?? [];
  const actions=initialState?.actions ?? [];
  const findings=initialState?.findings ?? [];
  const issueKeys=new Set(initialState?.issueKeys ?? []);
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
    version:1,queue,visited:[...visited],screens,actions,findings,issueKeys:[...issueKeys]
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
  while(queue.length){
    if(screens.length>=maxStates||actions.length>=maxActions){truncated=true;break;}
    const task=queue.shift(),path=task.path;
    let atNewChild=false;
    if(task.reuseCurrent){
      const current=await inspectBrowser(page);
      atNewChild=graphKey(current)===task.expectedGraph;
    }
    const reached=atNewChild?{ok:true}:await reach(path);
    if(!reached.ok){
      findings.push({code:"route-unreachable",path:path.map(el=>el.selector),reason:reached.reason});
      await onCheckpoint(checkpoint());
      continue;
    }
    const view=await inspectBrowser(page),key=graphKey(view);
    const firstVisit=!visited.has(key);
    if(!firstVisit&&task.nextAction===0)continue;
    if(firstVisit){
      visited.add(key);
      const accessibilityTree=await page.locator("body").ariaSnapshot({timeout:3000}).catch(()=>null);
      screens.push({name:view.title,path:path.map(el=>el.selector),
        elements:view.elements,focus:view.focus,announcements:view.announcements,
        accessibilityTree});
      for(const element of view.elements)for(const issue of element.issues){
        const issueKey=key+"|"+element.selector+"|"+issue;
        if(issueKeys.has(issueKey))continue;
        issueKeys.add(issueKey);
        findings.push({code:issue,screen:view.title,element:element.selector,
          name:element.name,source:element.source});
      }
    }
    if(path.length>=maxDepth){
      await progress();
      await onCheckpoint(checkpoint());
      continue;
    }
    const priority=el=>el.role==="button"||el.role==="link"||el.role==="tab"?0:
      el.kind==="select"?1:el.kind==="click"?2:3;
    const targets=[...view.elements].sort((a,b)=>priority(a)-priority(b));
    let paused=false;
    let descended=false;
    for(let index=task.nextAction;index<targets.length;index++){
      if(actions.length>=maxActions){
        queue.unshift({path,nextAction:index});
        truncated=true;
        paused=true;
        break;
      }
      const target=targets[index];
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
      const apiResponses=[];
      const observe=response=>{
        if(new URL(response.url()).pathname.startsWith("/api/"))
          apiResponses.push({status:response.status(),path:new URL(response.url()).pathname});
      };
      page.on("response",observe);
      let result;
      try{
        result=await clickBrowser(page,target);
        await page.waitForTimeout(180);
      }finally{page.off("response",observe);}
      const after=await inspectBrowser(page);
      const changed=signature(before)!==signature(after)
        ||JSON.stringify(before.announcements)!==JSON.stringify(after.announcements);
      if(result.ok&&after.focus&&!after.focus.visible)
        findings.push({code:"focus-hidden-after-action",screen:view.title,
          element:target.selector,name:target.name,focus:after.focus,source:target.source});
      actions.push({screen:view.title,selector:target.selector,name:target.name,
        kind:target.kind,success:result.ok,changed,reason:result.reason??null,
        apiResponses,announcements:after.announcements,after:after.title,
        focus:after.focus,source:target.source});
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
      if(descended)break;
    }
    await progress();
    await onCheckpoint(checkpoint());
    if(paused)break;
  }
  const blockedRoutes=findings.filter(f=>f.code==="route-unreachable"||f.code==="route-unreachable-before-action").length;
  return {
    name,screens,actions,findings,checkpoint:checkpoint(),
    summary:{screens:screens.length,actions:actions.length,blockedRoutes,
      complete:!truncated&&blockedRoutes===0,
      elements:screens.reduce((n,screen)=>n+screen.elements.length,0),
      issues:findings.length,changed:actions.filter(action=>action.changed).length,
      truncated,pending:queue.length}
  };
}
