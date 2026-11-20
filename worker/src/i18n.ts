import { be } from "../../web/js/locales/be.js";

// The canonical vocabulary is shared with the browser. Only developer-authored
// server metadata is localized; chat text, names, and message previews never are.
const templates = Object.entries(be).filter(([key]) => /\{\{\d+\}\}/.test(key))
  .map(([key,translated])=>{
    const parts=key.split(/\{\{\d+\}\}/);
    const ids=[...key.matchAll(/\{\{(\d+)\}\}/g)].map(x=>Number(x[1]));
    const escaped=parts.map(x=>x.replace(/[.*+?^$\{\}()|[\]\\]/g,"\\$&"));
    return {length:parts.join("").length,translated,ids,regex:new RegExp("^"+escaped.join("([\\s\\S]*?)")+"$")};
  }).filter(x=>x.length>=4).sort((a,b)=>b.length-a.length);

export function translateServerText(message:string):string {
  const exact=be[message];
  if(exact)return exact;
  for(const item of templates) {
    const match=message.match(item.regex);
    if(!match)continue;
    const captures:Record<number,string>={};
    item.ids.forEach((id,index)=>captures[id]=match[index+1]);
    return item.translated.replace(/\{\{(\d+)\}\}/g,(_,id)=>{
      const value=captures[Number(id)]??"";
      return be[value]??value;
    });
  }
  return message;
}

export async function localizeApiResponse(request:Request,response:Response):Promise<Response> {
  if(!/^be(?:-|,|;|$)/i.test((request.headers.get("accept-language")??"").trim()))return response;
  if(!new URL(request.url).pathname.startsWith("/api/"))return response;
  if(!response.headers.get("content-type")?.includes("application/json"))return response;
  let data:unknown;
  try {data=await response.clone().json();}catch{return response;}
  if(!data || typeof data!=="object" || Array.isArray(data))return response;
  const body=data as Record<string,unknown>;
  let changed=false;
  if(body.error && typeof body.error==="object" && !Array.isArray(body.error)){
    const error=body.error as Record<string,unknown>;
    if(typeof error.message==="string"){
      const t=translateServerText(error.message);
      if(t!==error.message){error.message=t;changed=true;}
    }
  }
  for(const key of ["note","message"]){
    if(typeof body[key]!=="string")continue;
    const old=body[key] as string,t=translateServerText(old);
    if(old!==t){body[key]=t;changed=true;}
  }
  if(!changed)return response;
  const headers=new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body),{status:response.status,statusText:response.statusText,headers});
}
