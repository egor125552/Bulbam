import {logDiagnostic,logTraceEvent,diagnosticErrorName} from './diagnostics-log.js';

// Browser-observable details of the entire app. The browser does not expose
// internal Cloudflare processes, device firmware, audio samples or private data.
// Everything below is local to this tab until the user exports the journal.
let started=false;
const safeControlId=/^[a-z][a-z0-9-]{1,55}$/i;
const forbiddenId=/(?:password|secret|token|recovery|passkey|credential|email|code|auth|login|register|username|query|search|message-input|textarea)/i;
const allowedEventTypes=new Set(['pageshow','pagehide','online','offline','focus','blur']);
const supportedInitiators=new Set(['fetch','xmlhttprequest','img','script','link','css','beacon','audio','other']);
function targetName(target){
  const item=target?.closest?.('button,select,summary,form,a,input,textarea,[role=button]');
  const id=item?.id || item?.dataset?.openSettings || item?.dataset?.settingsSubpage || '';
  if(!safeControlId.test(id)||forbiddenId.test(id)||item?.closest?.('[data-diagnostics-private]'))return 'скрытый элемент';
  return id;
}
export function setupDetailedDiagnostics(){
  if(started)return;
  started=true;
  logDiagnostic('Навигация','подробный журнал активирован');
  for(const kind of allowedEventTypes)window.addEventListener(kind,()=>logDiagnostic('Навигация',`событие ${kind}`));
  window.addEventListener('resize',()=>logTraceEvent('Интерфейс','изменение размера окна','',{count:1}));
  document.addEventListener('focusin',event=>{
    const label=targetName(event.target);
    if(label!=='скрытый элемент')logDiagnostic('Интерфейс','фокус',label);
  },true);
  document.addEventListener('submit',event=>logDiagnostic('Интерфейс','отправлена форма',targetName(event.target)),true);
  document.addEventListener('visibilitychange',()=>logDiagnostic('Навигация','состояние вкладки',document.visibilityState==='visible'?'видима':'скрыта'));
  for(const type of ['bulbam:account-changed','bulbam:chat-changed','bulbam:language-changed','bulbam:presence-updated']) {
    window.addEventListener(type,event=>{
      if(type==='bulbam:account-changed')logDiagnostic('Навигация','изменение сеанса',event.detail?.account?'вход':'выход');
      else if(type==='bulbam:chat-changed')logDiagnostic('Навигация','смена чата',event.detail?.chat?.kind==='group'?'группа':event.detail?.chat?'личный':'закрыт');
      else if(type==='bulbam:language-changed')logDiagnostic('Интерфейс','смена языка');
      else logTraceEvent('Сеть','получены статусы активности','',{count:Array.isArray(event.detail?.users)?event.detail.users.length:0});
    });
  }
  try {
    const entry=performance?.getEntriesByType?.('navigation')?.[0];
    if(entry)logTraceEvent('Навигация','загрузка страницы','',{durationMs:entry.duration,bytes:entry.transferSize});
  }catch{}
  if(typeof PerformanceObserver!=='undefined'){
    for(const kind of ['resource','longtask'])try{
      const observer=new PerformanceObserver(list=>{
        for(const entry of list.getEntries()) {
          if(kind==='resource') {
            // Important: resource.name is a URL and is intentionally never read.
            const initiator=supportedInitiators.has(entry.initiatorType)?entry.initiatorType:'other';
            logTraceEvent('Сеть',`загрузка ресурса ${initiator}`,'',{durationMs:entry.duration,bytes:entry.transferSize});
          }else logTraceEvent('Интерфейс','долгая задача','',{durationMs:entry.duration});
        }
      });
      observer.observe({type:kind,buffered:false});
    }catch{}
  }
  window.addEventListener('error',event=>{
    if(event.target!==window){
      const type=event.target?.tagName?.toLowerCase?.() || 'resource';
      const kind=['img','script','audio','link','video'].includes(type)?type:'other';
      logDiagnostic('Ошибки','ресурс не загрузился',kind);
    }
  },true);
  window.addEventListener('unhandledrejection',event=>{
    logDiagnostic('Ошибки','событие необработанного Promise',diagnosticErrorName(event.reason));
  });
  if(navigator.serviceWorker){
    navigator.serviceWorker.addEventListener('controllerchange',()=>logDiagnostic('Навигация','сменился Service Worker'));
    navigator.serviceWorker.addEventListener('message',()=>logDiagnostic('Сеть','событие Service Worker'));
  }
}
