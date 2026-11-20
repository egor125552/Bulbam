// Independent simple-controls preference. Detailed help stays in accessibility-help.js.
const SIMPLE_KEY = "bulbam.accessibility.simpleControls";
const choiceGroups = new Map();
let simple = false;
let observer;
const read = () => { try { return localStorage.getItem(SIMPLE_KEY); } catch { return null; } };
const save = value => { try { localStorage.setItem(SIMPLE_KEY, String(value)); } catch {} };
export function isSimpleControlsEnabled() { return simple; }
export function setupAccessibilityOptions() {
  simple = read() === "true";
  const toggle = document.querySelector("#settings-simple-controls");
  if (toggle) {
    toggle.checked = simple;
    toggle.addEventListener("change", () => {
      simple = toggle.checked;
      save(simple);
      applyAccessibilitySettings();
    });
  }
  window.addEventListener("bulbam:language-changed", () => queueMicrotask(updateChoices));
  observer?.disconnect();
  observer = new MutationObserver(records => {
    if (records.some(record => record.removedNodes?.length))
      for (const [select, group] of choiceGroups)
        if (!select.isConnected) { group.remove(); choiceGroups.delete(select); }
    if (records.some(record => [...record.addedNodes].some(node =>
      node.nodeType === 1 && (node.matches("select") || node.querySelector("select"))
    ))) setupSimpleChoices();
    if (simple && records.some(record =>
      record.type === "childList" && (record.target.matches?.("select, optgroup") ||
        record.target.closest?.("select") ||
        [...record.addedNodes].some(node => node.nodeType === 1 && node.matches("option, optgroup")))
    )) updateChoices();
    if (simple && records.some(record => record.type === "attributes" && record.target.matches?.("select")))
      updateChoices();
  });
  observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:["disabled"]});
  applyAccessibilitySettings();
}
export function applyAccessibilitySettings() {
  document.documentElement.dataset.simpleControls = simple ? "on" : "off";
  setupSimpleChoices();
  window.dispatchEvent(new CustomEvent("bulbam:accessibility-changed", {detail:{simpleControls:simple}}));
}
function setupSimpleChoices(){
  for (const [select, group] of choiceGroups) {
    if (!select.isConnected) { group.remove(); choiceGroups.delete(select); }
  }
  for(const select of document.querySelectorAll("select")){
    let group=choiceGroups.get(select);
    if(!group){
      group=document.createElement("div");
      group.className="settings-simple-options";
      group.setAttribute("role","group");
      const label = select.id ? [...document.querySelectorAll("label[for]")].find(item => item.htmlFor === select.id) : null;
      const labelId = select.getAttribute("aria-labelledby");
      const name = label?.textContent?.trim() || select.getAttribute("aria-label") ||
        (labelId && document.getElementById(labelId)?.textContent?.trim()) || "Выберите вариант";
      group.setAttribute("aria-label", name);
      select.after(group);
      choiceGroups.set(select,group);
      select.addEventListener("change",()=>updateChoices());
    }
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
