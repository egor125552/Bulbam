import { webcrypto } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test, vi } from "vitest";
import { generateConversationSecret, importConversationSecret } from "../web/js/secure-messages.js";
import {
 encryptedVoiceMime, generateVoiceNonce, encryptVoicePart,
 VOICE_PLAIN_CHUNK_BYTES, VOICE_CIPHER_CHUNK_BYTES
} from "../web/js/secure-voice.js";
import { protectedVoiceRanges, readProtectedVoiceChunks, selectVoiceSourceType, createProtectedVoiceStream } from "../web/js/secure-voice-stream.js";

let previousCrypto;
beforeAll(() => { previousCrypto = globalThis.crypto; Object.defineProperty(globalThis,"crypto",{ value:webcrypto,configurable:true }); });
afterAll(() => { if(previousCrypto) Object.defineProperty(globalThis,"crypto",{value:previousCrypto,configurable:true}); });

const context = {
 conversationId:"a1111111-1111-4111-8111-111111111111",
 senderUserId:"b2222222-2222-4222-8222-222222222222",
 clientMessageId:"voice_buffered_1234"
};

async function recording() {
 const key=await importConversationSecret(generateConversationSecret());
 const mimeType=encryptedVoiceMime("audio/webm;codecs=opus",generateVoiceNonce());
 const original=new Uint8Array(VOICE_PLAIN_CHUNK_BYTES+37).fill(71);
 original[original.length-1]=11;
 const first=await encryptVoicePart(original.subarray(0,VOICE_PLAIN_CHUNK_BYTES),key,mimeType,context,1);
 const last=await encryptVoicePart(original.subarray(VOICE_PLAIN_CHUNK_BYTES),key,mimeType,context,2,original.length);
 return {key,mimeType,original,wire:new Uint8Array([...first,...last])};
}

describe("progressive encrypted voice", () => {
 test("requests exact 256 KiB ranges and rejects invalid sizes",()=>{
   expect(protectedVoiceRanges(VOICE_CIPHER_CHUNK_BYTES+53)).toEqual([
     {partNumber:1,start:0,end:VOICE_CIPHER_CHUNK_BYTES-1},
     {partNumber:2,start:VOICE_CIPHER_CHUNK_BYTES,end:VOICE_CIPHER_CHUNK_BYTES+52}
   ]);
   expect(()=>protectedVoiceRanges(0)).toThrow();
   expect(()=>protectedVoiceRanges(33*1024*1024)).toThrow();
 });
 test("decrypts and yields the first part before fetching the next",async()=>{
   const {key,mimeType,original,wire}=await recording();
   const requests=[];
   const fetchImpl=async (_,opts)=>{
     requests.push(opts.headers.Range);
     const m=/^bytes=(\d+)-(\d+)$/.exec(opts.headers.Range);
     const start=Number(m[1]),end=Number(m[2]);
     return new Response(wire.slice(start,end+1),{status:206,headers:{"content-range":`bytes ${start}-${end}/${wire.length}`}});
   };
   const chunks=readProtectedVoiceChunks({url:"/test",key,mimeType,context,ciphertextBytes:wire.length,fetchImpl});
   const first=await chunks.next();
   expect(new Uint8Array(first.value)).toEqual(original.slice(0,VOICE_PLAIN_CHUNK_BYTES));
   expect(requests).toHaveLength(1);
   const second=await chunks.next();
   expect(new Uint8Array(second.value)).toEqual(original.slice(VOICE_PLAIN_CHUNK_BYTES));
   expect(requests).toHaveLength(2);
   expect((await chunks.next()).done).toBe(true);
 });
 test("refuses server downgrade, bad ranges, and ciphertext edits", async()=>{
   const {key,mimeType,wire}=await recording();
   const base={url:"/test",key,mimeType,context,ciphertextBytes:wire.length};
   await expect(readProtectedVoiceChunks({...base,fetchImpl:async()=>new Response(wire,{status:200})}).next()).rejects.toThrow();
   await expect(readProtectedVoiceChunks({...base,fetchImpl:async()=>new Response(wire.slice(0,VOICE_CIPHER_CHUNK_BYTES),{status:206,headers:{"content-range":"bytes 1-99/100"}})}).next()).rejects.toThrow();
   const broken=wire.slice(); broken[9]^=1;
   const fetchImpl=async (_,opts)=>{
     const [start,end]=opts.headers.Range.slice(6).split("-").map(Number);
     return new Response(broken.slice(start,end+1),{status:206,headers:{"content-range":`bytes ${start}-${end}/${broken.length}`}});
   };
   await expect(readProtectedVoiceChunks({...base,fetchImpl}).next()).rejects.toThrow();
 });
 test("prefers managed source on Safari and checks codecs",()=>{
   class Managed {}
   class Standard {}
   Managed.isTypeSupported=()=>true;
   Standard.isTypeSupported=()=>true;
   const mimeType=encryptedVoiceMime("audio/mp4",generateVoiceNonce());
   expect(selectVoiceSourceType(mimeType,{ManagedMediaSource:Managed,MediaSource:Standard}).constructor).toBe(Managed);
   expect(selectVoiceSourceType(mimeType,{})).toBeNull();
 });
 test("progressive media source appends verified audio chunks instead of a full file",async()=>{
   const {key,mimeType,original,wire}=await recording();
   const appended=[], requested=[];
   class FakeSourceBuffer extends EventTarget {
     buffered={length:0}; updating=false;
     appendBuffer(chunk){
       appended.push(new Uint8Array(chunk));
       queueMicrotask(()=>this.dispatchEvent(new Event("updateend")));
     }
   }
   class FakeManagedSource extends EventTarget {
     static isTypeSupported(type){return type.includes("opus");}
     readyState="closed";
     ended=false;
     constructor(){super();queueMicrotask(()=>{this.readyState="open";this.dispatchEvent(new Event("sourceopen"));});}
     addSourceBuffer(){return new FakeSourceBuffer();}
     endOfStream(){this.ended=true;this.readyState="ended";}
   }
   const oldManaged=globalThis.ManagedMediaSource;
   const oldStandard=globalThis.MediaSource;
   Object.defineProperty(globalThis,"ManagedMediaSource",{configurable:true,value:FakeManagedSource});
   Object.defineProperty(globalThis,"MediaSource",{configurable:true,value:undefined});
   vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:voice-test");
   try{
     const audio={currentTime:0,readyState:0,seeking:false,disableRemotePlayback:false,src:""};
     const session=createProtectedVoiceStream({
       audio,url:"/secure-voice",mimeType,ciphertextBytes:wire.length,key,context,
       fetchImpl:async(_,opts)=>{
         requested.push(opts.headers.Range);
         const [start,end]=opts.headers.Range.slice(6).split("-").map(Number);
         return new Response(wire.slice(start,end+1),{
           status:206,headers:{"content-range":`bytes ${start}-${end}/${wire.length}`}
         });
       },
       isStillAuthorized:()=>true
     });
     expect(audio.disableRemotePlayback).toBe(true);
     expect(audio.src).toBe("blob:voice-test");
     await session.done;
     expect(requested).toHaveLength(2);
     expect(appended).toHaveLength(2);
     expect(new Uint8Array([...appended[0],...appended[1]])).toEqual(original);
     session.stop();
   }finally{
     vi.restoreAllMocks();
     if(oldManaged===undefined)delete globalThis.ManagedMediaSource;
     else Object.defineProperty(globalThis,"ManagedMediaSource",{configurable:true,value:oldManaged});
     if(oldStandard===undefined)delete globalThis.MediaSource;
     else Object.defineProperty(globalThis,"MediaSource",{configurable:true,value:oldStandard});
   }
 });

});
