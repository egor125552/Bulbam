// Aggregate all findings from every explored screen, without discarding
// repetitions. Distinct rule+element pairs are grouped; their occurrences
// and source screens remain available for diagnosis.
const SEVERITY_ORDER={critical:0,serious:1,moderate:2,minor:3,unknown:4};
export function groupFindings(reports=[]) {
  const groups=new Map();
  const bySeverity={critical:0,serious:0,moderate:0,minor:0,unknown:0};
  let occurrences=0;
  for(const report of reports){
    for(const finding of report.findings??[]){
      const code=String(finding.code||"unknown");
      const selector=String(finding.selector||finding.element||
        (Array.isArray(finding.path)?finding.path.join(" > "):"unknown"));
      const key=JSON.stringify([code,selector]);
      const severity=SEVERITY_ORDER[finding.severity]===undefined
        ? "unknown":finding.severity;
      const screen=String(finding.screen||report.name||"Неизвестный экран");
      let group=groups.get(key);
      if(!group){
        group={code,selector,severity,message:finding.message||finding.summary||"",
          source:finding.source||null,occurrences:0,screens:[]};
        groups.set(key,group);
        bySeverity[severity]++;
      }else if(SEVERITY_ORDER[severity]<SEVERITY_ORDER[group.severity]){
        bySeverity[group.severity]--;
        bySeverity[severity]++;
        group.severity=severity;
      }
      occurrences++;
      group.occurrences++;
      if(!group.screens.includes(screen))group.screens.push(screen);
      if(!group.source&&finding.source)group.source=finding.source;
    }
  }
  const results=[...groups.values()].sort((a,b)=>
    SEVERITY_ORDER[a.severity]-SEVERITY_ORDER[b.severity] ||
    b.occurrences-a.occurrences ||
    a.code.localeCompare(b.code) ||
    a.selector.localeCompare(b.selector));
  return {occurrences,uniqueIssues:results.length,bySeverity,groups:results};
}
