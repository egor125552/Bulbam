// Screen Wake Lock is advisory. iOS may release it when the page is hidden.
export function createCallWakeLock(navigatorLike, documentLike) {
  let active=false, lock=null, generation=0, requesting=null;
  async function acquire(){
    if(!active || documentLike.visibilityState==="hidden" || lock || requesting ||
       typeof navigatorLike?.wakeLock?.request!=="function")return false;
    const epoch=generation;
    requesting=Promise.resolve().then(()=>navigatorLike.wakeLock.request("screen"));
    try {
      const sentinel=await requesting;
      if(!active || generation!==epoch){await sentinel.release?.();return false;}
      lock=sentinel;
      sentinel.addEventListener?.("release",()=>{if(lock===sentinel)lock=null;});
      return true;
    }catch{return false;}
    finally{requesting=null;}
  }
  return {
    activate(){active=true;return acquire();},
    onVisible(){return acquire();},
    async deactivate(){active=false;generation++;const previous=lock;lock=null;try{await previous?.release?.();}catch{}},
    get active(){return active;}
  };
}
