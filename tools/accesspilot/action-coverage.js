// Coverage belongs to a control in its *local interactive context*, not
// to an entire application DOM snapshot. Otherwise a newly shown toast,
// draft panel or chat conversation causes the same global navigation control
// to be counted again, and the queue grows forever.
export function actionIdentity(element,stateKey=""){
  const context=element.scopeKey??("legacy-graph:"+stateKey);
  return JSON.stringify([
    context,element.selector,element.role??"",element.kind??"",
    element.state??"",!!element.disabled
  ]);
}

export function missingActionCandidates({
  screens=[],actions=[],maxDepth=Infinity,unreachableActions=[]
}={}){
  const done=new Set(actions.map(action=>action.actionKey??
    actionIdentity(action,action.stateKey)));
  const unreachable=new Set(unreachableActions);
  const unique=new Set();
  const pending=[];
  for(const screen of screens){
    if((screen.path?.length??0)>=maxDepth)continue;
    for(const target of screen.elements??[]){
      if(target.disabled||(target.kind==="fill"&&target.readOnly))continue;
      // Disabled and read-only controls stay in the inventory, but cannot be activated.
      const actionKey=actionIdentity(target,screen.stateKey);
      if(done.has(actionKey)||unreachable.has(actionKey)||unique.has(actionKey))
        continue;
      unique.add(actionKey);
      pending.push({screen,target,actionKey});
    }
  }
  return pending;
}
