import {existsSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {chromium} from "playwright";

export async function launchHeadless() {
  const explicit=process.env.ACCESSPILOT_BROWSER_PATH;
  if(explicit)return chromium.launch({headless:true,executablePath:explicit});
  try{return await chromium.launch({headless:true});}
  catch(original) {
    const root=join(homedir(),".cache","ms-playwright");
    const folders=existsSync(root)?readdirSync(root).filter(x=>/^chromium-[0-9]+$/.test(x)).sort().reverse():[];
    for(const folder of folders) {
      const options=[
        join(root,folder,"chrome-linux","chrome"),
        join(root,folder,"chrome-linux64","chrome"),
      ];
      for(const executablePath of options){
        if(!existsSync(executablePath))continue;
        try{return await chromium.launch({headless:true,executablePath});}catch{}
      }
    }
    throw original;
  }
}
