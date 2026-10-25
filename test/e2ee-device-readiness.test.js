import {test,expect} from 'vitest';
import {checkDeviceE2EEReadiness} from '../web/js/message-encryption-route.js';
const local={localDeviceId:'mine',devices:[{deviceId:'mine',trust:'active'}]};
const active={users:[{userId:'bob',devices:[{deviceId:'peer',trust:'active'}]}]};
const options=(result,owner=local)=>({
 accountId:'alice',conversationId:'chat',recipientUserId:'bob',
 status:async()=>owner,request:async()=>result
});
test('a contact without trusted devices cannot be forced into device-only sending',async()=>{
 expect(await checkDeviceE2EEReadiness(options({users:[{userId:'bob',devices:[]}]}))).toBe(false);
});
test('a pending local device falls back to available older encrypted sending',async()=>{
 expect(await checkDeviceE2EEReadiness(options(active,{...local,devices:[{deviceId:'mine',trust:'pending'}]}))).toBe(false);
});
test('two active trusted endpoints are ready',async()=>{
 expect(await checkDeviceE2EEReadiness(options(active))).toBe(true);
});
test('network failures must not be mistaken for lack of keys',async()=>{
 const o=options(active);o.request=async()=>{throw Error('Offline');};
 await expect(checkDeviceE2EEReadiness(o)).rejects.toThrow('Offline');
});
