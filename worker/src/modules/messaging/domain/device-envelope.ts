import {badRequest} from '../../../core/errors';
import type {DevicePublicKey} from './device-key-validation';

export interface SealedDeviceEnvelope {
  version:2;
  clientMessageId:string;
  senderDeviceId:string;
  recipientUserId:string;
  recipientDeviceId:string;
  ephemeralPublicKey:DevicePublicKey;
  nonce:string;
  ciphertext:string;
  signature:string;
}
export interface StoredDeviceEnvelope extends SealedDeviceEnvelope {
  envelopeId:string;conversationId:string;senderUserId:string;createdAt:number;
  senderSigningKey?:DevicePublicKey;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64=/^[A-Za-z0-9_-]+$/;
export function validateEnvelope(body:Record<string,unknown>):SealedDeviceEnvelope {
  if(body.version!==2)badRequest('e2ee_version','Неподдерживаемый формат зашифрованного сообщения.');
  for(const field of ['clientMessageId','senderDeviceId','recipientUserId','recipientDeviceId']){
    if(typeof body[field]!=='string'||!uuid.test(body[field] as string))
      badRequest('invalid_e2ee_envelope','Неверный идентификатор конверта.');
  }
  const key=body.ephemeralPublicKey;
  if(!key||typeof key!=='object'||Array.isArray(key))badRequest('invalid_e2ee_key','Нет открытого ключа сообщения.');
  const jwk=key as Record<string,unknown>;
  if(jwk.kty!=='EC'||jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string'||
     !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)||!/^[A-Za-z0-9_-]{43}$/.test(jwk.y))
    badRequest('invalid_e2ee_key','Неправильный ключ сообщения.');
  if(typeof body.nonce!=='string'||!/^[A-Za-z0-9_-]{16}$/.test(body.nonce)||
     typeof body.ciphertext!=='string'||body.ciphertext.length<24||body.ciphertext.length>24576||
     !b64.test(body.ciphertext)||typeof body.signature!=='string'||
     !/^[A-Za-z0-9_-]{86}$/.test(body.signature))
    badRequest('invalid_e2ee_envelope','Неверный формат шифротекста или подписи.');
  return {
    version:2,
    clientMessageId:String(body.clientMessageId).toLowerCase(),
    senderDeviceId:String(body.senderDeviceId).toLowerCase(),
    recipientUserId:String(body.recipientUserId).toLowerCase(),
    recipientDeviceId:String(body.recipientDeviceId).toLowerCase(),
    ephemeralPublicKey:{kty:'EC',crv:'P-256',x:String(jwk.x),y:String(jwk.y)},
    nonce:String(body.nonce),ciphertext:String(body.ciphertext),signature:String(body.signature)
  };
}
export function deviceEnvelopeProof(conversationId:string,senderUserId:string,envelope:Omit<SealedDeviceEnvelope,'signature'>):string {
  return JSON.stringify(['bulbam/e2ee-device-envelope/v2',conversationId,senderUserId,
    envelope.clientMessageId,envelope.senderDeviceId,envelope.recipientUserId,
    envelope.recipientDeviceId,envelope.ephemeralPublicKey,envelope.nonce,envelope.ciphertext]);
}
export function deviceEnvelopeKdf(conversationId:string,senderUserId:string,envelope:Pick<SealedDeviceEnvelope,'clientMessageId'|'senderDeviceId'|'recipientUserId'|'recipientDeviceId'|'ephemeralPublicKey'>):string{
  return JSON.stringify(['bulbam/e2ee-device-kdf/v2',conversationId,senderUserId,
    envelope.clientMessageId,envelope.senderDeviceId,envelope.recipientUserId,
    envelope.recipientDeviceId,envelope.ephemeralPublicKey]);
}
