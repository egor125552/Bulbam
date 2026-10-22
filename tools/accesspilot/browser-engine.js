// Universal browser explorer: no knowledge of Bulbam routes, IDs or button meanings.
// Discovers actions from the live accessibility surface, then interacts via browser APIs.
const TARGETS = 'button, a[href], input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="link"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="textbox"], [role="searchbox"], [tabindex]:not([tabindex="-1"])';
const safeName = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 170);

export async function inspectBrowser(page) {
  return await page.evaluate(selector => {
    const norm = value => String(value || "").replace(/\s+/g, " ").trim();
    const activeDialog = [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')].find(el => el.getClientRects().length) ?? null;
    function visible(node, ignoreAria=false) {
      if(activeDialog){
        let within=false;
        for(let p=node;p&&p.nodeType===1;p=p.parentElement||p.getRootNode()?.host){
          if(p===activeDialog){within=true;break;}
        }
        if(!within)return false;
      }
      for (let p=node; p && p.nodeType===1; p=p.parentElement||p.getRootNode()?.host) {
        if (p.hidden || (!ignoreAria && p.getAttribute('aria-hidden')==='true') || p.inert) return false;
        const style=getComputedStyle(p);
        if (style.display==='none' || style.visibility==='hidden') return false;
      }
      return node.getClientRects().length > 0;
    }
    function name(el) {
      const refs=el.getAttribute('aria-labelledby');
      if (refs) {
        const n=norm(refs.split(/\s+/).map(id=>(el.getRootNode()?.getElementById?.(id)||document.getElementById(id))?.textContent).join(' '));
        if(n)return n;
      }
      if (norm(el.getAttribute('aria-label')))return norm(el.getAttribute('aria-label'));
      const lab=el.labels?.length ? [...el.labels].map(l=>l.textContent).join(' ') : '';
      if(norm(lab))return norm(lab);
      if(el.closest('label'))return norm(el.closest('label').textContent);
      if(['BUTTON','A','SUMMARY'].includes(el.tagName)||el.getAttribute('role')==='button')
        return norm(el.innerText||el.textContent);
      if(el.tagName==='INPUT' && ['submit','button','reset'].includes(el.type))return norm(el.value||'Отправить');
      return norm(el.getAttribute('title')||'');
    }
    function role(el) {
      if(el.getAttribute('role'))return el.getAttribute('role');
      if(el.tagName==='BUTTON')return 'button';
      if(el.tagName==='A')return 'link';
      if(el.tagName==='TEXTAREA'||el.isContentEditable)return 'textbox';
      if(el.tagName==='SELECT')return 'combobox';
      if(el.tagName==='SUMMARY')return 'button';
      if(el.tagName==='INPUT')return ['checkbox','radio','range'].includes(el.type)?el.type:
        ['submit','reset','button'].includes(el.type)?'button':'textbox';
      return 'generic';
    }
    function path(el) {
      const root=el.getRootNode();
      const shadowPrefix=root?.host ? path(root.host)+' ' : '';
      if(el.id) return shadowPrefix + '#' + CSS.escape(el.id);
      const parts=[];
      for(let n=el;n && n.tagName && n!==document.documentElement;n=n.parentElement){
        const parent=n.parentElement;
        if(!parent){parts.unshift(n.tagName.toLowerCase());break;}
        const same=[...parent.children].filter(e=>e.tagName===n.tagName);
        parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+(same.indexOf(n)+1)+')');
        if(parent.id){parts.unshift('#'+CSS.escape(parent.id));break;}
      }
      return shadowPrefix + parts.join(' > ');
    }
    function discoverAll(root){
      const matches=[];
      for(const el of root.querySelectorAll('*')){
        if(el.matches(selector))matches.push(el);
        if(el.shadowRoot)matches.push(...discoverAll(el.shadowRoot));
      }
      return matches;
    }
    const candidates=discoverAll(document);
    const inventory=candidates.map(el=>({
      selector:path(el),name:name(el),role:role(el),
      visible:visible(el,true),exposed:visible(el),
      disabled:!!el.disabled,readOnly:!!el.readOnly
    }));
    const elements=candidates.filter(node=>visible(node,true))
      .filter(el=>!el.closest('button,a[href]') || el.matches('button,a[href]'));
    // Nearest semantic landmark is the unit of interaction coverage. A change
    // in a different panel must not make this control a brand-new task.
    const scopeSelector='dialog,[role="dialog"],[role="menu"],[role="toolbar"],[role="tablist"],form,nav,header,footer,aside,section,fieldset,main,article';
    function scopeRoot(node){
      for(let p=node;p&&p.nodeType===1;p=p.parentElement||p.getRootNode()?.host){
        if(p.matches(scopeSelector))return p;
      }
      return document.body;
    }
    const scopes=new Map();
    for(const element of elements){
      const root=scopeRoot(element);
      if(!scopes.has(root))scopes.set(root,[]);
      scopes.get(root).push(element);
    }
    const scopeKeys=new Map();
    for(const [root,members] of scopes){
      scopeKeys.set(root,JSON.stringify([
        path(root),members.map(member=>[
          path(member),role(member),member.tagName.toLowerCase(),
          member.getAttribute('type')||'',!!member.disabled
        ])
      ]));
    }
    const state=elements.map(el=>{
      const issues=[];
      const roleName=role(el), label=name(el);
      if(!visible(el))issues.push('interactive-hidden-from-screen-reader');
      if(!label && roleName!=='generic')issues.push('missing-name');
      if(el.getAttribute('aria-labelledby'))
        for(const id of el.getAttribute('aria-labelledby').split(/\s+/))
          if(id && !document.getElementById(id))issues.push('broken-labelledby:'+id);
      if(Number(el.getAttribute('tabindex')||0)>0)issues.push('positive-tabindex');
      if(el.getAttribute('role')==='button'&&!['BUTTON','A'].includes(el.tagName)
        && !el.hasAttribute('tabindex'))issues.push('custom-button-not-focusable');
      const inputType=el.getAttribute('type')||'';
      const type=el.matches('select')?'select':
        el.matches('input[type="range"],[role="slider"]')?'adjust':
        el.matches('textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"]')?'fill':
        el.matches('input:not([type="button"]):not([type="submit"]):not([type="reset"])')
          ?(['checkbox','radio'].includes(inputType)?'click': 'fill'):'click';
      return {
        selector:path(el), name:label, role:roleName,
        scopeKey:scopeKeys.get(scopeRoot(el)),
        kind:type, inputType, required:!!el.required, disabled:!!el.disabled, readOnly:!!el.readOnly,
        state:el.getAttribute('aria-expanded')||el.getAttribute('aria-pressed')||
          el.getAttribute('aria-checked')|| (el.checked?'checked':(el.type==='checkbox'?'unchecked':'')),
        value:el.matches('input,textarea,select')?String(el.value??'').slice(0,55):'', 
        issues, options:el.tagName==='SELECT'?[...el.options].map(x=>x.value):[],
        source:window.__accesspilotSource?.(el)??null
      };
    });
    const extraIssues=[];
    function discoverCanvases(root){
      const list=[...root.querySelectorAll('canvas')];
      for(const node of root.querySelectorAll('*'))if(node.shadowRoot)
        list.push(...discoverCanvases(node.shadowRoot));
      return list;
    }
    for(const canvas of discoverCanvases(document)){
      if(!visible(canvas))continue;
      const labelled=norm(canvas.getAttribute('aria-label')||
        canvas.getAttribute('title')||canvas.textContent);
      if(!labelled)extraIssues.push({
        code:'canvas-without-accessible-alternative',element:path(canvas),
        message:'Canvas has no accessible description or fallback text. WebAssembly or WebGL controls require DOM/ARIA equivalents.'
      });
    }
    let focus=document.activeElement;
    while(focus?.shadowRoot?.activeElement)focus=focus.shadowRoot.activeElement;
    const announcements=[...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
      .filter(visible).map(node=>norm(node.textContent).slice(0,180)).filter(Boolean).slice(-12);
    return {
      inventory,
      issues:extraIssues,
      announcements,
      title: activeDialog?.getAttribute('aria-label') || activeDialog?.querySelector('h1,h2,h3')?.textContent?.trim()
        || [...document.querySelectorAll('main h2')].find(visible)?.textContent?.trim() || document.title,
      focus: focus && focus!==document.body? { selector:path(focus), name:name(focus), visible:visible(focus) }:null,
      elements:state
    };
  }, TARGETS);
}

async function fillNearbyForm(page, locator) {
  // Generic, semantic form preparation. The caller provides no per-button
  // script. Only submit controls trigger auto-population.
  const id=await locator.evaluate(element=>{
    const submit=(element.tagName==='BUTTON'||element.tagName==='INPUT')
      && (element.type||'submit')==='submit';
    return submit ? (element.form?.id||null) : null;
  }).catch(()=>null);
  if(!id)return 0;
  const fields=page.locator('#'+CSS_ESCAPE(id)).locator('input:not([type="hidden"]),textarea,select');
  let count=0;
  for(let n=0;n<await fields.count();n++){
    const field=fields.nth(n);
    if(!await field.isVisible().catch(()=>false))continue;
    const info=await field.evaluate(el=>({
      tag:el.tagName,type:el.type||'',name:el.name||'',autocomplete:el.autocomplete||'',
      required:!!el.required,value:String(el.value||''),checked:!!el.checked,
      min:el.min||'',max:el.max||'',minlength:el.minLength||0
    }));
    if(info.tag==='SELECT'){
      if(info.value)continue;
      const options=await field.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value));
      const option=options.find(Boolean);if(option){await field.selectOption(option);count++;}continue;
    }
    if(['submit','button','reset','file'].includes(info.type))continue;
    if(['checkbox','radio'].includes(info.type)){
      if(info.required&&!info.checked){await field.check();count++;}continue;
    }
    if(info.value)continue;
    let value=info.type==='password'?'AccessPilot-Temporary-Password-2026!':
      info.type==='email'?'pilot@example.test':info.type==='url'?'https://example.test':
      info.type==='tel'?'+15550001000':info.type==='number'?(info.min||'3'):
      info.autocomplete.includes('username')?'accesspilot_tester':
      info.type==='search'?'pilot':'AccessPilot test input';
    if(info.minlength>value.length)value=value.padEnd(info.minlength,'x');
    await field.fill(value,{timeout:3200});
    count++;
  }
  return count;
}
function CSS_ESCAPE(text){return text.replace(/[^a-zA-Z0-9_-]/g,x=>'\\'+x);}

export async function clickBrowser(page, target) {
  const loc=page.locator(target.selector).first();
  if (target.disabled) return { ok:false, reason:'disabled' };
  if (target.kind==='fill'&&target.readOnly) return {ok:false,reason:'read-only'};
  try {
    if(target.kind==='adjust'){
      await loc.focus({timeout:3200});
      await page.keyboard.press('ArrowRight');
    }else if(target.kind==='select') {
      // Select an alternate valid item without any application-specific mapping.
      const current=await loc.inputValue();
      const next=target.options.find(x=>x!==current && x!=='')??current;
      if(next===current)return {ok:false,reason:'no-other-option'};
      await loc.selectOption(next,{timeout:3200});
    } else if(target.kind==='fill') {
      if(target.inputType==='file')return {ok:false,reason:'file-input-requires-fixture'};
      const value=target.inputType==='email'?'pilot@example.test':
        target.inputType==='number'?'3':target.inputType==='tel'?'+15550001000':
        target.inputType==='password'?'AccessPilot-Isolated-2026!':
        target.inputType==='url'?'https://example.test':
        target.inputType==='search'?'pilot':'Тестовое сообщение AccessPilot';
      await loc.fill(value,{timeout:3200});
      if(target.inputType==='search')await page.waitForTimeout(270);
    } else {
      await fillNearbyForm(page,loc);
      await loc.click({timeout:3200});
    }
    await page.waitForTimeout(110);
    return {ok:true};
  } catch(error) {
    // Links that are visually moved offscreen can still be keyboard accessible.
    // Test their real keyboard activation rather than declare them broken.
    if (target.kind === "click") {
      try {
        await loc.focus({timeout:1200});
        await page.keyboard.press("Enter");
        await page.waitForTimeout(80);
        return {ok:true,via:"keyboard"};
      } catch {}
    }
    return {ok:false,reason:String(error?.message||error).split('\n').slice(0,2).join(' ').slice(0,200)};
  }
}
