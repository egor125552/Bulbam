import {badRequest} from '../../../core/errors';

export interface DevicePublicKey {kty:'EC';crv:'P-256';x:string;y:string}
export interface DeviceBundle {
  deviceId:string;
  identitySigning:DevicePublicKey;
  identityAgreement:DevicePublicKey;
  signedPrekey:DevicePublicKey;
  prekeySignature:string;
  registrationSignature:string;
}
export interface RegisteredDevice extends DeviceBundle {
  userId:string;
  trust:'active'|'pending'|'revoked';
  createdAt:number;
}

function key(input:unknown):DevicePublicKey {
  if(!input||typeof input!=='object'||Array.isArray(input))badRequest('invalid_device_key','Неверный ключ устройства.');
  const value=input as Record<string,unknown>;
  if(value.kty!=='EC'||value.crv!=='P-256'||
    typeof value.x!=='string'||typeof value.y!=='string'||
    !/^[A-Za-z0-9_-]{43}$/.test(value.x)||!/^[A-Za-z0-9_-]{43}$/.test(value.y))
    badRequest('invalid_device_key','Нужен корректный открытый ключ P-256.');
  return {kty:'EC',crv:'P-256',x:value.x as string,y:value.y as string};
}
function signature(value:unknown):string {
  if(typeof value!=='string'||! /^[A-Za-z0-9_-]{86}$/.test(value))
    badRequest('invalid_device_signature','Подпись устройства имеет неправильный формат.');
  return value;
}
export function validateDeviceBundle(value:Record<string,unknown>):DeviceBundle {
  if(typeof value.deviceId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.deviceId))
    badRequest('invalid_device_id','Некорректный идентификатор устройства.');
  return {
    deviceId:(value.deviceId as string).toLowerCase(),
    identitySigning:key(value.identitySigning),
    identityAgreement:key(value.identityAgreement),
    signedPrekey:key(value.signedPrekey),
    prekeySignature:signature(value.prekeySignature),
    registrationSignature:signature(value.registrationSignature)
  };
}
export function keyEnvelope(kind:'prekey'|'registration'|'approval',userId:string,deviceId:string,bundle:DeviceBundle,approvingId?:string):string {
  switch(kind){
    case 'prekey':return JSON.stringify(['bulbam/device-prekey/v1',userId,deviceId,bundle.signedPrekey]);
    case 'registration':return JSON.stringify(['bulbam/device-registration/v1',userId,deviceId,
      bundle.identitySigning,bundle.identityAgreement,bundle.signedPrekey,bundle.prekeySignature]);
    case 'approval':return JSON.stringify(['bulbam/device-approval/v1',userId,approvingId,deviceId,
      bundle.identitySigning,bundle.identityAgreement,bundle.signedPrekey]);
  }
}
function signatureBytes(encoded:string):Uint8Array {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let buffer=0,bits=0;const bytes:number[]=[];
  for(const ch of encoded){buffer=(buffer<<6)|chars.indexOf(ch);bits+=6;
    if(bits>=8){bits-=8;bytes.push((buffer>>bits)&255);}}
  return new Uint8Array(bytes);
}
export async function verifyDeviceSignature(publicKey:DevicePublicKey,content:string,signature:string):Promise<boolean> {
  try {
    const key=await crypto.subtle.importKey('jwk',publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,new Uint8Array(signatureBytes(signature)).buffer as ArrayBuffer,new TextEncoder().encode(content));
  }catch{return false;}
}
export async function verifyDeviceBundle(userId:string,bundle:DeviceBundle):Promise<boolean>{
  try{
    await Promise.all([bundle.identityAgreement,bundle.signedPrekey].map(k=>
      crypto.subtle.importKey('jwk',k,{name:'ECDH',namedCurve:'P-256'},false,[])));
    const signer=bundle.identitySigning;
    return await verifyDeviceSignature(signer,keyEnvelope('prekey',userId,bundle.deviceId,bundle),bundle.prekeySignature)
      && await verifyDeviceSignature(signer,keyEnvelope('registration',userId,bundle.deviceId,bundle),bundle.registrationSignature);
  }catch{return false;}
}
