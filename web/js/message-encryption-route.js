// A protected direct chat uses per-device envelopes instead of the older
// account-wide shared key, including when the old key still exists.
export function shouldUseDeviceE2EE(chat,security,featureEnabled){
 return chat?.kind==='direct' && !chat.encryptionOptOut &&
   security?.disabled===false && featureEnabled===true;
}


// A failed network lookup must remain a real error, not permission to send raw text.
// Pending/untrusted devices are not ready for the new per-device transport.
export async function checkDeviceE2EEReadiness({accountId,conversationId,recipientUserId,status,request}){
 const own=await status();
 if(!own.devices.some(d=>d.deviceId===own.localDeviceId&&d.trust==='active'))return false;
 const directory=await request('/api/v1/chats/'+conversationId+'/e2ee/devices');
 const recipients=directory.users?.find(user=>user.userId===recipientUserId)?.devices??[];
 return recipients.some(device=>device.trust==='active');
}
