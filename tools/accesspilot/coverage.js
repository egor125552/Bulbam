// Optional source coverage analysis for static HTML apps. This does not
// prescribe test routes or assign meaning to individual buttons.
export function measureStaticCoverage(html, scenarios) {
  const found=[];
  const pattern=/<(button|input|textarea|select)\b[^>]*?\bid\s*=\s*(['"])([^'"]+)\2[^>]*>/gi;
  for(const match of html.matchAll(pattern)) {
    const line=html.slice(0,match.index).split("\n").length;
    found.push({tag:match[1].toLowerCase(),id:match[3],line,file:"web/index.html"});
  }
  const rendered=new Set(),activated=new Set(),successful=new Set();
  for(const scenario of scenarios) {
    for(const screen of scenario.screens) {
      for(const element of screen.elements)if(element.selector?.startsWith("#"))rendered.add(element.selector.slice(1));
    }
    for(const action of scenario.actions){
      if(action.selector?.startsWith("#")){
        const id=action.selector.slice(1);
        activated.add(id);
        if(action.success)successful.add(id);
      }
    }
  }
  const unique=[...new Map(found.map(item=>[item.id,item])).values()];
  return {
    totalStaticControls:unique.length,
    rendered:unique.filter(item=>rendered.has(item.id)).length,
    attempted:unique.filter(item=>activated.has(item.id)).length,
    activated:unique.filter(item=>successful.has(item.id)).length,
    notActivated:unique.filter(item=>!successful.has(item.id))
  };
}
