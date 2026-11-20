import {readFile} from "node:fs/promises";
import {isAbsolute,resolve,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function nonEmpty(value,label){
  if(typeof value!=="string"||!value.trim())throw new Error("AccessPilot config: "+label+" must be a non-empty string");
  return value;
}
function bounded(value,label,fallback,min,max){
  if(value===undefined)return fallback;
  if(!Number.isInteger(value)||value<min||value>max)
    throw new Error("AccessPilot config: "+label+" must be between "+min+" and "+max);
  return value;
}
export function normalizeProjectConfig(input,configFile="accesspilot.project.json"){
  if(!isObject(input))throw new Error("AccessPilot config: expected JSON object");
  if(input.version!==1)throw new Error("AccessPilot config: version must be 1");
  const name=nonEmpty(input.name,"name");
  const provider=input.provider===undefined?null:nonEmpty(input.provider,"provider");
  const url=input.url===undefined?null:nonEmpty(input.url,"url");
  if(!provider&&!url)throw new Error("AccessPilot config: specify url or provider");
  if(url){
    let parsed;
    try{parsed=new URL(url);}catch{throw new Error("AccessPilot config: invalid url");}
    if(!["http:","https:"].includes(parsed.protocol))throw new Error("AccessPilot config: only HTTP(S) URLs");
  }
  if(provider&&(!provider.startsWith("./")&&!provider.startsWith("../")))
    throw new Error("AccessPilot config: provider must be a relative local module");
  const scenarios=input.scenarios??[{name:"default",profile:"guest"}];
  if(!Array.isArray(scenarios)||!scenarios.length)throw new Error("AccessPilot config: scenarios must be non-empty array");
  const names=new Set();
  const normalizedScenarios=scenarios.map((scenario,index)=>{
    if(!isObject(scenario))throw new Error("AccessPilot config: invalid scenario "+index);
    const scenarioName=nonEmpty(scenario.name,"scenario.name");
    if(names.has(scenarioName))throw new Error("AccessPilot config: duplicate scenario "+scenarioName);
    names.add(scenarioName);
    return {name:scenarioName,profile:scenario.profile??"guest",
      ready:scenario.ready??null,
      permissions:scenario.permissions??[]};
  });
  for(const scenario of normalizedScenarios){
    nonEmpty(scenario.profile,"scenario.profile");
    if(scenario.ready!==null)nonEmpty(scenario.ready,"scenario.ready");
    if(!Array.isArray(scenario.permissions)||scenario.permissions.some(x=>typeof x!=="string"))
      throw new Error("AccessPilot config: scenario.permissions must be a string array");
  }
  const screens=input.screens??[];
  if(!Array.isArray(screens))throw new Error("AccessPilot config: screens must be an array");
  const knownScreens=screens.map((screen,index)=>{
    if(!isObject(screen))throw new Error("AccessPilot config: screen "+index+" is invalid");
    return {name:nonEmpty(screen.name,"screens[].name"),
      selector:nonEmpty(screen.selector,"screens[].selector")};
  });
  const limits=input.limits??{};
  if(!isObject(limits))throw new Error("AccessPilot config: limits must be an object");
  const mode=input.mode??(provider?"explore":"audit");
  if(!["audit","explore"].includes(mode))throw new Error("AccessPilot config: mode must be audit or explore");
  if(mode==="explore"&&!provider&&url&&
    !["localhost","127.0.0.1","[::1]"].includes(new URL(url).hostname))
    throw new Error("AccessPilot config: external targets are audit-only without an isolated provider");
  return {version:1,name,url,provider,mode,scenarios:normalizedScenarios,screens:knownScreens,
    limits:{
      maxActions:bounded(limits.maxActions,"limits.maxActions",300,1,10000),
      maxStates:bounded(limits.maxStates,"limits.maxStates",100,1,1000),
      maxDepth:bounded(limits.maxDepth,"limits.maxDepth",7,1,30)
    },configFile:resolve(configFile),directory:dirname(resolve(configFile))};
}

export async function readProjectConfig(configFile){
  const path=resolve(configFile);
  const content=JSON.parse(await readFile(path,"utf8"));
  return normalizeProjectConfig(content,path);
}

export function resolveProjectProvider(config){
  if(!config.provider)return null;
  return pathToFileURL(resolve(config.directory,config.provider)).href;
}

export function projectRunSummary(reports,expectedScreens=[]){
  const covered=new Set(reports.flatMap(r=>r.screens.flatMap(s=>s.landmarks??[])));
  return {
    scenarios:reports.length,
    states:reports.reduce((n,r)=>n+r.summary.screens,0),
    actions:reports.reduce((n,r)=>n+r.summary.actions,0),
    auditedStates:reports.reduce((n,r)=>n+(r.summary.auditedStates??0),0),
    untested:reports.reduce((n,r)=>n+(r.summary.untested??0),0),
    complete:reports.every(r=>r.summary.complete===true),
    screens:expectedScreens.map(s=>({name:s.name,selector:s.selector,
      visited:covered.has(s.name)}))
  };
}
