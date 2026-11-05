import {describe,test,expect,vi} from "vitest";
import {createCallWakeLock} from "../web/js/call-wake-lock.js";
import {createCallPocketMode} from "../web/js/call-pocket-mode.js";
import {createCallKeepaliveAudio} from "../web/js/call-keepalive-audio.js";

describe("iPhone call wake-lock behavior",()=>{
 test("acquires during call, reacquires after visibility return, releases when call ends",async()=>{
  const issued=[];
  const documentLike={visibilityState:"visible"};
  const request=vi.fn(async type=>{
   expect(type).toBe("screen");
   const handlers={};
   const sentinel={addEventListener:(name,fn)=>handlers[name]=fn,release:vi.fn(async()=>{handlers.release?.();})};
   issued.push(sentinel);
   return sentinel;
  });
  const lock=createCallWakeLock({wakeLock:{request}},documentLike);
  expect(await lock.activate()).toBe(true);
  expect(await lock.activate()).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  documentLike.visibilityState="hidden";
  await issued[0].release();
  expect(await lock.onVisible()).toBe(false);
  documentLike.visibilityState="visible";
  expect(await lock.onVisible()).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  await lock.deactivate();
  expect(issued[1].release).toHaveBeenCalledOnce();
  expect(await lock.onVisible()).toBe(false);
 });
 test("late acquisition is released after a finished call",async()=>{
  let finish;
  const request=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
  const lock=createCallWakeLock({wakeLock:{request}},{visibilityState:"visible"});
  const pending=lock.activate();
  await Promise.resolve(); // Request started.
  await lock.deactivate();
  const sentinel={release:vi.fn(async()=>{})};
  finish(sentinel);
  expect(await pending).toBe(false);
  expect(sentinel.release).toHaveBeenCalledOnce();
 });
 test("unsupported Wake Lock never prevents call setup",async()=>{
  const lock=createCallWakeLock({},{visibilityState:"visible"});
  expect(await lock.activate()).toBe(false);
  await expect(lock.deactivate()).resolves.toBeUndefined();
 });
});

test("pocket mode preserves the same call and exits through the single accessible button",()=>{
 const values=new Set();
 const classList={
  add:vi.fn(value=>values.add(value)),
  remove:vi.fn(value=>values.delete(value)),
  contains:value=>values.has(value)
 };
 const panel={classList};
 const button={hidden:true,textContent:"",focus:vi.fn()};
 const announce=vi.fn();
 const pocket=createCallPocketMode(panel,button,announce);
 pocket.enter();
 expect(pocket.enabled).toBe(true);
 expect(classList.contains("is-pocket")).toBe(true);
 expect(button.hidden).toBe(false);
 expect(button.textContent).toBe("Выйти из режима в кармане");
 expect(button.focus).toHaveBeenCalledOnce();
 expect(announce.mock.calls[0][0]).toContain("Для выхода");
 pocket.exit();
 expect(pocket.enabled).toBe(false);
 expect(classList.contains("is-pocket")).toBe(false);
 expect(button.textContent).toBe("Режим в кармане");
 pocket.enter();
 pocket.reset();
 expect(button.hidden).toBe(true);
 expect(classList.contains("is-pocket")).toBe(false);
});

test("call background audio loops quietly and is stopped on hangup",async()=>{
 const audio={paused:true,loop:false,volume:1,currentTime:12,
  play:vi.fn(async()=>{audio.paused=false;}),
  pause:vi.fn(()=>{audio.paused=true;})
 };
 const session={metadata:null};
 const player=createCallKeepaliveAudio(audio,{mediaSession:session});
 player.activate("Собеседник");
 expect(audio.volume).toBe(0.01);
 expect(audio.loop).toBe(true);
 await player.resume();
 expect(audio.play).toHaveBeenCalledOnce();
 player.deactivate();
 expect(audio.pause).toHaveBeenCalledOnce();
 expect(audio.currentTime).toBe(0);
 expect(session.metadata).toBeNull();
 await player.resume();
 expect(audio.play).toHaveBeenCalledOnce();
});

test("late keepalive playback cannot restart after hangup",async()=>{
 let settle;
 const audio={paused:true,currentTime:0,volume:1,loop:false,
  play:vi.fn(()=>new Promise(resolve=>{settle=()=>{audio.paused=false;resolve();};})),
  pause:vi.fn(()=>{audio.paused=true;})};
 const player=createCallKeepaliveAudio(audio,{});
 player.activate("Caller");
 await Promise.resolve();
 player.deactivate();
 settle();
 await vi.waitFor(()=>expect(audio.pause).toHaveBeenCalledTimes(2));
 expect(audio.paused).toBe(true);
});

test("stale cached app shell without keepalive audio cannot break a call",async()=>{
 const noAudio=createCallKeepaliveAudio(null,{});
 expect(noAudio.activate("Caller")).toBe(false);
 await expect(noAudio.resume()).resolves.toBeUndefined();
 expect(()=>noAudio.deactivate()).not.toThrow();
 const incompleteAudio=createCallKeepaliveAudio({play:async()=>{}},{});
 expect(incompleteAudio.activate("Caller")).toBe(false);
 expect(()=>incompleteAudio.deactivate()).not.toThrow();
});
test("stale cached app shell without pocket button remains usable",()=>{
 const panel={classList:{add:vi.fn(),remove:vi.fn()}};
 const pocket=createCallPocketMode(panel,null,vi.fn());
 expect(()=>{pocket.enter();pocket.exit();pocket.reset();}).not.toThrow();
 expect(pocket.enabled).toBe(false);
});
