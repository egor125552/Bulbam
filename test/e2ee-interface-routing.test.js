import {test,expect} from 'vitest';
import {shouldUseDeviceE2EE} from '../web/js/message-encryption-route.js';

const chat={kind:'direct',conversationId:'chat-1',peer:{userId:'bob'}};
const legacyKey={sendKey:{type:'secret'},blocked:false,requiresKey:false,disabled:false};
test('device E2EE replaces the legacy send path even when its older shared key exists',()=>{
 expect(shouldUseDeviceE2EE(chat,legacyKey,true)).toBe(true);
});
test('the new route still works when the old shared key is unavailable',()=>{
 expect(shouldUseDeviceE2EE(chat,{...legacyKey,sendKey:null,blocked:true,requiresKey:true},true)).toBe(true);
});
test('explicitly disabled protection and group chats never take the device route',()=>{
 expect(shouldUseDeviceE2EE({...chat,encryptionOptOut:true},legacyKey,true)).toBe(false);
 expect(shouldUseDeviceE2EE(chat,{...legacyKey,disabled:true},true)).toBe(false);
 expect(shouldUseDeviceE2EE({...chat,kind:'group'},legacyKey,true)).toBe(false);
 expect(shouldUseDeviceE2EE(chat,legacyKey,false)).toBe(false);
});
