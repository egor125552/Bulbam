// Execute this isolated, application-agnostic recorder before any page script.
// It does not invoke handlers or alter their behavior; it records their origin.
export function installSourceTracking() {
  const born=new WeakMap(),handlers=new WeakMap();
  function origin() {
    const stack=String(new Error().stack||"");
    const match=stack.match(/(?:https?:\/\/[^/]+)?(\/js\/[^:\s)]+\.js):(\d+):(\d+)/);
    if(!match)return null;
    return {file:"web"+match[1],line:Number(match[2]),column:Number(match[3])};
  }
  const create=document.createElement.bind(document);
  document.createElement=function(...args) {
    const element=create(...args);
    const source=origin();
    if(source)born.set(element,source);
    return element;
  };
  const register=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(kind,handler,...rest) {
    const source=origin();
    if(source) {
      const history=handlers.get(this)||[];
      history.push({kind, function:handler?.name||null, ...source});
      handlers.set(this,history);
    }
    return register.call(this,kind,handler,...rest);
  };
  window.__accesspilotSource=element=>({
    created:born.get(element)||null,handlers:handlers.get(element)||[]
  });
}
