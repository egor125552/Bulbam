const HELP_KEY="bulbam.accessibility.detailedHelp";
const SIMPLE_KEY="bulbam.accessibility.simpleControls";
const LEGACY_HELP_KEY="bulbam.accessibility.detailedRecordingHelp";
const descriptions=new WeakMap();
const knownElements=new Set();
const choiceGroups=new Map();
let detailed=true, simple=false;
let observer;
function read(key){try{return localStorage.getItem(key);}catch{return null;}}
function write(key,value){try{localStorage.setItem(key,String(value));}catch{}}
export function isDetailedHelpEnabled(){return detailed;}
export function isSimpleControlsEnabled(){return simple;}
export function recordingStartAnnouncement(trigger){
  return recordingStartText(detailed,trigger);
}
export function recordingStartText(detailedHelp,trigger){
  if(!detailedHelp)return "Запись началась.";
  return trigger==="option"
   ? "Запись голосового началась. Отпусти Option, чтобы отправить. Escape отменяет запись."
   : "Запись голосового началась. Нажми кнопку ещё раз, чтобы отправить.";
}

export function setupAccessibilityOptions(){
  const old=read(LEGACY_HELP_KEY), stored=read(HELP_KEY);
  detailed=stored===null?old!=="false":stored!=="false";
  simple=read(SIMPLE_KEY)==="true";
  const help=document.querySelector("#settings-detailed-help");
  const controls=document.querySelector("#settings-simple-controls");
  if(help){
    help.checked=detailed;
    help.addEventListener("change",()=>{
      detailed=help.checked;
      write(HELP_KEY,detailed);
      write(LEGACY_HELP_KEY,detailed);
      applyAccessibilitySettings();
    });
  }
  if(controls){
    controls.checked=simple;
    controls.addEventListener("change",()=>{
      simple=controls.checked;
      write(SIMPLE_KEY,simple);
      applyAccessibilitySettings();
    });
  }
  window.addEventListener("bulbam:language-changed",()=>queueMicrotask(updateChoices));
  applyAccessibilitySettings();
  observer?.disconnect();
  observer=new MutationObserver(records=>{
    if(records.some(record=>record.addedNodes.length))updateHintDescriptions();
    if(records.some(record=>[...record.addedNodes].some(node=>
      node.nodeType===1 && (node.matches("select") || node.querySelector("select"))
    )))setupSimpleChoices();
  });
  observer.observe(document.body,{subtree:true,childList:true});
}
export function applyAccessibilitySettings(){
  document.documentElement.dataset.detailedHelp=detailed?"on":"off";
  document.documentElement.dataset.simpleControls=simple?"on":"off";
  updateHintDescriptions();
  setupSimpleChoices();
  window.dispatchEvent(new CustomEvent("bulbam:accessibility-changed",{
    detail:{detailedHelp:detailed,simpleControls:simple}
  }));
}
function updateHintDescriptions(){
  for(const element of document.querySelectorAll("[aria-describedby]")){
    if(!descriptions.has(element)){
      descriptions.set(element,element.getAttribute("aria-describedby"));
      knownElements.add(element);
    }
  }
  for(const element of knownElements){
    if(!element.isConnected){knownElements.delete(element);continue;}
    const original=descriptions.get(element);
    if(!original)continue;
    const ids=original.split(/\s+/).filter(Boolean);
    const visible=detailed?ids:ids.filter(id=>{
      const target=document.getElementById(id);
      return !target || !(target.classList.contains("hint")||/-hint$/.test(id));
    });
    const next=visible.join(" ");
    if(next!==element.getAttribute("aria-describedby")){
      if(next)element.setAttribute("aria-describedby",next);
      else element.removeAttribute("aria-describedby");
    }
  }
}
function setupSimpleChoices(){
  for(const select of document.querySelectorAll("select")){
    let group=choiceGroups.get(select);
    if(!group){
      group=document.createElement("div");
      group.className="settings-simple-options";
      group.setAttribute("role","group");
      const label=document.querySelector('label[for="'+select.id+'"]');
      group.setAttribute("aria-label",label?.textContent?.trim()??"Выберите вариант");
      select.after(group);
      choiceGroups.set(select,group);
      select.addEventListener("change",()=>updateChoices());
    }
    select.hidden=simple;
    group.hidden=!simple;
    if(simple)fillChoiceGroup(select,group);
  }
}
function fillChoiceGroup(select,group){
  if(!simple)return;
  group.replaceChildren();
  for(const option of select.options){
    const button=document.createElement("button");
    button.type="button";
    button.textContent=option.textContent.trim();
    const chosen=option.value===select.value;
    button.setAttribute("aria-pressed",String(chosen));
    // aria-pressed conveys selection in VoiceOver without a language-dependent suffix.
    button.setAttribute("aria-label",option.textContent.trim());
    button.disabled=option.disabled||select.disabled;
    button.addEventListener("click",()=>{
      const value=option.value;
      if(value!==select.value){
        select.value=value;
        select.dispatchEvent(new Event("change",{bubbles:true}));
      }
      fillChoiceGroup(select,group);
      const index=[...select.options].findIndex(opt=>opt.value===value);
      group.querySelectorAll("button")[index]?.focus();
    });
    group.append(button);
  }
}
function updateChoices(){
  for(const [select,group] of choiceGroups)fillChoiceGroup(select,group);
}
