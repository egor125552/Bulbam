import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test,expect} from 'vitest';
const source=readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');
async function testDelivery({kind,visible}){
  const handlers={};const shown=[];
  const self={location:{origin:'https://example.test'},
    addEventListener:(name,handler)=>{handlers[name]=handler;},
    clients:{matchAll:async()=>visible?[{url:'https://example.test/',visibilityState:'visible'}]:[]},
    registration:{showNotification:async(title,opts)=>{shown.push({title,opts});}},
    navigator:{}};
  vm.runInNewContext(source,{self,URL,setTimeout,console,indexedDB:undefined,caches:{keys:async()=>[]}});
  let task;
  handlers.push({data:{json:()=>({kind,title:'Паша',body:'Привет',tag:'chat-test',data:{url:'/'}})},waitUntil:p=>{task=p;}});
  await task;
  return shown;
}
test('a message push is suppressed only by a visible window on the receiving device',async()=>{
 expect(await testDelivery({kind:'message',visible:true})).toHaveLength(0);
 expect(await testDelivery({kind:'message',visible:false})).toHaveLength(1);
});
test('an explicit notification test always displays even when the app is visible',async()=>{
 expect(await testDelivery({kind:'test',visible:true})).toHaveLength(1);
});
