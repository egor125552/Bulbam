#!/usr/bin/env node
import {resolve} from "node:path";
import {readProjectConfig,normalizeProjectConfig} from "./project-config.js";
import {runProject} from "./project-runner.js";

const usage=`AccessPilot: universal screen-reader accessibility explorer

Usage:
  node tools/accesspilot/cli.js [--config path.json] [--scenario NAME]
                                [--output DIR] [--resume]
  node tools/accesspilot/cli.js --url http://localhost:8080 [--explore]

Project JSON describes app URL, optional screen landmarks and fixture provider.
It does NOT prescribe which buttons to click. For live external websites,
only read-only accessibility audit is allowed without an isolated provider.
Environment: ACCESSPILOT_MAX_ACTIONS, ACCESSPILOT_MAX_STATES,
             ACCESSPILOT_FAKE_MEDIA=1
`;
function parseArgs(argv){
  const flags={scenarios:[]};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==="--help"||arg==="-h"){flags.help=true;continue;}
    if(arg==="--resume"){flags.resume=true;continue;}
    if(arg==="--explore"){flags.explore=true;continue;}
    if(["--config","--url","--scenario","--output"].includes(arg)){
      if(!argv[i+1]||argv[i+1].startsWith("--"))
        throw new Error("Missing value for "+arg);
      const value=argv[++i];
      if(arg==="--scenario")flags.scenarios.push(value);
      else flags[arg.slice(2)]=value;
      continue;
    }
    throw new Error("Unknown AccessPilot option: "+arg);
  }
  return flags;
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(args.help){process.stdout.write(usage);return;}
  if(args.url&&args.config)throw new Error("Use either --url or --config, not both");
  const config=args.url
    ? normalizeProjectConfig({version:1,name:new URL(args.url).hostname,
      url:args.url,mode:args.explore?"explore":"audit"},"accesspilot-url.json")
    :await readProjectConfig(args.config??"tools/accesspilot/accesspilot.project.json");
  const result=await runProject(config,{
    scenarioNames:args.scenarios.length?args.scenarios:
      (process.env.ACCESSPILOT_SCENARIOS
        ?process.env.ACCESSPILOT_SCENARIOS.split(",").map(x=>x.trim()).filter(Boolean):null),
    outputDir:resolve(args.output??"accesspilot-report"),
    resume:!!args.resume||process.env.ACCESSPILOT_RESUME==="1"
  });
  if(result.scenarios.some(s=>s.findings.some(f=>f.code==="scenario-failed")))
    process.exitCode=2;
}
main().catch(error=>{
  console.error("ACCESSPILOT_ERROR",error?.stack||String(error));
  process.exitCode=1;
});
