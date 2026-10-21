// Universal browser explorer: no knowledge of Bulbam routes, IDs or button meanings.
// Discovers actions from the live accessibility surface, then interacts via browser APIs.
const TARGETS = 'button, a[href], input, textarea, select, summary, [role="button"], [role="link"], [role="switch"], [role="checkbox"], [role="tab"], [tabindex]:not([tabindex="-1"])';
const safeName = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 170);

export async function inspectBrowser(page) {
  return await page.evaluate(selector => {
    const norm = value => String(value || "").replace(/\s+/g, " ").trim();
    const activeDialog = [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')].find(el => el.getClientRects().length) ?? null;
    function visible(node, ignoreAria=false) {
      if (activeDialog && !activeDialog.contains(node)) return false;
      for (let p=node; p && p.nodeType===1; p=p.parentElement) {
        if (p.hidden || (!ignoreAria && p.getAttribute('aria-hidden')==='true') || p.inert) return false;
        const style=getComputedStyle(p);
        if (style.display==='none' || style.visibility==='hidden') return false;
      }
      return node.getClientRects().length > 0;
    }
    function name(el) {
      const refs=el.getAttribute('aria-labelledby');
      if (refs) {
        const n=norm(refs.split(/\s+/).map(id=>document.getElementById(id)?.textContent).join(' '));
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
      if(el.tagName==='TEXTAREA')return 'textbox';
      if(el.tagName==='SELECT')return 'combobox';
      if(el.tagName==='SUMMARY')return 'button';
      if(el.tagName==='INPUT')return ['checkbox','radio','range'].includes(el.type)?el.type:
        ['submit','reset','button'].includes(el.type)?'button':'textbox';
      return 'generic';
    }
    function path(el) {
      if(el.id) return '#' + CSS.escape(el.id);
      const parts=[];
      for(let n=el;n && n.tagName && n!==document.documentElement;n=n.parentElement){
        const parent=n.parentElement;
        if(!parent)break;
        const same=[...parent.children].filter(e=>e.tagName===n.tagName);
        parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+(same.indexOf(n)+1)+')');
        if(parent.id){parts.unshift('#'+CSS.escape(parent.id));break;}
      }
      return parts.join(' > ');
    }
    const elements=[...document.querySelectorAll(selector)].filter(node=>visible(node,true))
      .filter(el=>!el.closest('button,a[href]') || el.matches('button,a[href]'));
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
      const type=el.matches('select')?'select':el.matches('textarea')?'fill':
        el.matches('input:not([type="button"]):not([type="submit"]):not([type="reset"])')
          ?(['checkbox','radio'].includes(inputType)?'click': 'fill'):'click';
      return {
        selector:path(el), name:label, role:roleName,
        kind:type, inputType, required:!!el.required, disabled:!!el.disabled,
        state:el.getAttribute('aria-expanded')||el.getAttribute('aria-pressed')||
          el.getAttribute('aria-checked')|| (el.checked?'checked':(el.type==='checkbox'?'unchecked':'')),
        value:el.matches('input,textarea,select')?String(el.value??'').slice(0,55):'', 
        issues, options:el.tagName==='SELECT'?[...el.options].map(x=>x.value):[],
        source:window.__accesspilotSource?.(el)??null
      };
    });
    const focus=document.activeElement;
    const announcements=[...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
      .filter(visible).map(node=>norm(node.textContent).slice(0,180)).filter(Boolean).slice(-12);
    return {
      announcements,
      title: activeDialog?.getAttribute('aria-label') || activeDialog?.querySelector('h1,h2,h3')?.textContent?.trim()
        || [...document.querySelectorAll('main h2')].find(visible)?.textContent?.trim() || document.title,
      focus: focus && focus!==document.body? { selector:path(focus), name:name(focus), visible:visible(focus) }:null,
      elements:state
    };
  }, TARGETS);
}

export async function clickBrowser(page, target) {
  const loc=page.locator(target.selector).first();
  if (target.disabled) return { ok:false, reason:'disabled' };
  try {
    if(target.kind==='select') {
      // Select an alternate valid item without any application-specific mapping.
      const current=await loc.inputValue();
      const next=target.options.find(x=>x!==current && x!=='')??current;
      if(next===current)return {ok:false,reason:'no-other-option'};
      await loc.selectOption(next,{timeout:1300});
    } else if(target.kind==='fill') {
      if(target.inputType==='file')return {ok:false,reason:'file-input-requires-fixture'};
      const value=target.inputType==='email'?'pilot@example.test':
        target.inputType==='number'?'3':target.inputType==='tel'?'+15550001000':
        target.inputType==='password'?'AccessPilot-Isolated-2026!':
        target.inputType==='url'?'https://example.test':
        target.inputType==='search'?'pilot':'Тестовое сообщение AccessPilot';
      await loc.fill(value,{timeout:1300});
      if(target.inputType==='search')await page.waitForTimeout(270);
    } else {
      await loc.click({timeout:1300});
    }
    await page.waitForTimeout(110);
    return {ok:true};
  } catch(error) {
    // Links that are visually moved offscreen can still be keyboard accessible.
    // Test their real keyboard activation rather than declare them broken.
    if (target.kind === "click") {
      try {
        await loc.focus({timeout:700});
        await page.keyboard.press("Enter");
        await page.waitForTimeout(80);
        return {ok:true,via:"keyboard"};
      } catch {}
    }
    return {ok:false,reason:String(error?.message||error).split('\n').slice(0,2).join(' ').slice(0,200)};
  }
}

// Loop-safe BFS over discovered application states. For every action the browser
// is restarted at the current scenario's root and the discovered path replayed.
// No prewritten action maps or screen-specific assertions are required.
export async function crawlBrowser({
  page, reset, maxStates=45, maxActions=120, maxDepth=4, name='browser'
}) {
  const queue=[[]], visited=new Set(), findings=[], actions=[], screens=[];
  const issueKeys=new Set();
  let truncated=false;
  const signature = state => JSON.stringify(state.elements.map(e=>[
    e.selector,e.name,e.role,e.state,e.disabled,e.value
  ]));
  async function reach(path) {
    await reset();
    for (const step of path) {
      const result=await clickBrowser(page, step);
      if (!result.ok) return result;
    }
    return {ok:true};
  }
  while(queue.length) {
    if(screens.length>=maxStates || actions.length>=maxActions){truncated=true;break;}
    const path=queue.shift(), reached=await reach(path);
    if(!reached.ok){findings.push({code:'route-unreachable',path: path.map(x=>x.selector),reason:reached.reason});continue;}
    const view=await inspectBrowser(page);
    const key=signature(view);
    if(visited.has(key))continue;
    visited.add(key);
    const accessibilityTree=await page.locator("body").ariaSnapshot({timeout:3000}).catch(()=>null);
    screens.push({name:view.title,path:path.map(x=>x.selector),
      elements:view.elements,focus:view.focus,announcements:view.announcements,
      accessibilityTree});
    for(const element of view.elements)for(const issue of element.issues){
      const issueKey=key+'|'+element.selector+'|'+issue;
      if(issueKeys.has(issueKey))continue;
      issueKeys.add(issueKey);
      findings.push({code:issue,screen:view.title,element:element.selector,name:element.name,source:element.source});
    }
    if(path.length>=maxDepth)continue;
    // Prioritize controls that can open another screen, then inspect inputs and
    // toggles. This affects exploration order, never hardcodes a button.
    const priority=el=>el.role==="button"||el.role==="link"||el.role==="tab"?0:
      el.kind==="select"?1:el.kind==="click"?2:3;
    for(const el of [...view.elements].sort((a,b)=>priority(a)-priority(b))){
      if(actions.length>=maxActions){truncated=true;break;}
      const restored=await reach(path);
      if(!restored.ok)continue;
      const before=await inspectBrowser(page);
      const apiResponses=[];
      const observe=response=>{
        if(new URL(response.url()).pathname.startsWith('/api/'))
          apiResponses.push({status:response.status(),path:new URL(response.url()).pathname});
      };
      page.on('response',observe);
      const result=await clickBrowser(page,el);
      await page.waitForTimeout(180);
      page.off('response',observe);
      const after=await inspectBrowser(page);
      const changed=signature(before)!==signature(after)
        || JSON.stringify(before.announcements)!==JSON.stringify(after.announcements);
      if(result.ok && after.focus && !after.focus.visible)
        findings.push({code:"focus-hidden-after-action",screen:view.title,
          element:el.selector,name:el.name,focus:after.focus,source:el.source});
      actions.push({screen:view.title,selector:el.selector,name:el.name,kind:el.kind,
        success:result.ok,changed,reason:result.reason??null,apiResponses,
        announcements:after.announcements,after:after.title,
        focus:after.focus,source:el.source});
      const beforeStructure=JSON.stringify(before.elements.map(e=>[e.selector,e.role,e.name,e.disabled]));
      const afterStructure=JSON.stringify(after.elements.map(e=>[e.selector,e.role,e.name,e.disabled]));
      if(result.ok && beforeStructure!==afterStructure && !visited.has(signature(after)))
        queue.push([...path,el]);
    }
  }
  return {name,screens,actions,findings,
    summary:{screens:screens.length,actions:actions.length,elements:screens.reduce((n,s)=>n+s.elements.length,0),
      issues:findings.length,changed:actions.filter(a=>a.changed).length,truncated,
      pending:queue.length}};
}
