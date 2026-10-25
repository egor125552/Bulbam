// A protected direct chat uses per-device envelopes instead of the older
// account-wide shared key, including when the old key still exists.
export function shouldUseDeviceE2EE(chat,security,featureEnabled){
 return chat?.kind==='direct' && !chat.encryptionOptOut &&
   security?.disabled===false && featureEnabled===true;
}
