import {test,expect,vi} from 'vitest';
import {prepareVoiceOutput} from '../web/js/voice-output-route.js';
function fakeContext(){
 const events=[];
 class Context{
  constructor(){this.destination='speakers';this.events=events;}
  createMediaElementSource(el){
   events.push(['source',el]);
   return {connect(destination){events.push(['media-to',destination]);}};
  }
  createGain(){
   const node={channelCount:2,channelCountMode:'max',channelInterpretation:'discrete',
    connect(dest){events.push(['mono-to',dest]);}};
   events.push(['gain',node]);
   return node;
  }
  resume(){events.push(['resume']);return Promise.resolve();}
  close(){events.push(['close']);return Promise.resolve();}
 }
 return {Context,events};
}
test('encryption disabled: use the original audio element directly',()=>{
 const {Context,events}=fakeContext();
 expect(prepareVoiceOutput({},false,Context)).toBeNull();
 expect(events).toHaveLength(0);
});
test('encrypted voice: downmix the source then play centrally in both headphones',async()=>{
 const {Context,events}=fakeContext();
 const el={src:'blob:secure'};
 const route=prepareVoiceOutput(el,true,Context);
 expect(route).toBeTruthy();
 const mono=events.find(item=>item[0]==='gain')[1];
 expect(mono.channelCount).toBe(1);
 expect(mono.channelCountMode).toBe('explicit');
 expect(mono.channelInterpretation).toBe('speakers');
 expect(events).toContainEqual(['media-to',mono]);
 expect(events).toContainEqual(['mono-to','speakers']);
 await route.resume();
 await route.close();
 expect(events).toContainEqual(['close']);
});
test('protected voice falls back to unmodified media playback without Web Audio',()=>{
 expect(prepareVoiceOutput({},true,null)).toBeNull();
});
