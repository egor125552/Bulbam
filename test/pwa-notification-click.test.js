import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test,expect,vi} from 'vitest';

const code=readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');
function setup(clients){
  const listeners={};
  const self={location:{origin:'https://bulbam.test'},addEventListener:(type,fn)=>listeners[type]=fn,
    clients:{matchAll:async()=>clients,openWindow:vi.fn(async url=>({url})),claim:async()=>{}},
    skipWaiting:()=>{},registration:{showNotification:async()=>{}},navigator:{}};
  runInNewContext(code,{self,URL,console});
  const notificationclick=(path)=>{
    let task;
    listeners.notificationclick({notification:{close:vi.fn(),data:{url:path}},waitUntil:p=>task=p});
    return task;
  };
  return {self,notificationclick};
}
test('clicking a push focuses an existing app without navigating or reloading it',async()=>{
  const client={url:'https://bulbam.test/',focus:vi.fn(async()=>{}),navigate:vi.fn(async()=>{throw Error('should never navigate')}),postMessage:vi.fn()};
  const {notificationclick,self}=setup([client]);
  await notificationclick('/?chat=abcdef12-1234-1234-1234-1234567890ab');
  expect(client.focus).toHaveBeenCalledTimes(1);
  expect(client.navigate).not.toHaveBeenCalled();
  expect(client.postMessage).toHaveBeenCalledWith({
    type:'bulbam.notification-open',url:'/?chat=abcdef12-1234-1234-1234-1234567890ab'
  });
  expect(self.clients.openWindow).not.toHaveBeenCalled();
});
test('opening a push without an existing app opens a new window',async()=>{
  const {notificationclick,self}=setup([]);
  await notificationclick('/?reviewRecovery=1');
  expect(self.clients.openWindow).toHaveBeenCalledWith('https://bulbam.test/?reviewRecovery=1');
});
test('cross-origin notification links cannot open an arbitrary site',async()=>{
  const {notificationclick,self}=setup([]);
  await notificationclick('https://unknown.test/steal');
  expect(self.clients.openWindow).not.toHaveBeenCalled();
});
