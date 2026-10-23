// Generic DOM inventory. It describes coverage, not what buttons should do.
export function controlCoverage(reports=[]){
  const elements=new Map();
  for(const report of reports){
    for(const screen of report.screens??[]){
      for(const item of screen.inventory??screen.elements??[]){
        const id=item.selector;
        if(!id)continue;
        const saved=elements.get(id)??{selector:id,name:item.name??"",role:item.role??"",
          seen:0,visibleEver:false,exposedEver:false,attempted:false,activated:false,readOnlyOnly:false};
        saved.readOnlyOnly=saved.seen===0?!!item.readOnly:(saved.readOnlyOnly&&!!item.readOnly);
        saved.seen++;
        saved.visibleEver ||= item.visible??true;
        saved.exposedEver ||= item.exposed??true;
        if(item.name)saved.name=item.name;
        if(item.role)saved.role=item.role;
        elements.set(id,saved);
      }
    }
    for(const action of report.actions??[]){
      const id=action.selector;
      if(!id)continue;
      const saved=elements.get(id)??{selector:id,name:action.name??"",role:"",
        seen:0,visibleEver:false,exposedEver:false,attempted:false,activated:false};
      saved.attempted=true;
      saved.activated ||= !!action.success;
      if(action.name)saved.name=action.name;
      elements.set(id,saved);
    }
  }
  const controls=[...elements.values()].sort((a,b)=>a.selector.localeCompare(b.selector));
  return {
    total:controls.length,
    visible:controls.filter(x=>x.visibleEver).length,
    exposed:controls.filter(x=>x.exposedEver).length,
    attempted:controls.filter(x=>x.attempted).length,
    activated:controls.filter(x=>x.activated).length,
    neverVisible:controls.filter(x=>!x.visibleEver),
    readOnly:controls.filter(x=>x.readOnlyOnly),
    untested:controls.filter(x=>!x.attempted&&!x.readOnlyOnly),
    failed:controls.filter(x=>x.attempted&&!x.activated),
    controls
  };
}
