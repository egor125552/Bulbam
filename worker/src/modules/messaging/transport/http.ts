import { json, methodNotAllowed, readJsonObject } from "../../../core/http";
import type { MessagingService } from "../application/messaging-service";
import type { MessagingActor } from "../domain/models";

export type AuthenticateMessagingRequest = (request: Request) => Promise<MessagingActor>;

export async function handleMessagingHttp(
  request: Request,
  url: URL,
  service: MessagingService,
  authenticate: AuthenticateMessagingRequest
): Promise<Response | null> {
  if(url.pathname==='/api/v1/features'){
    if(request.method!=='GET')return methodNotAllowed(['GET']);
    await authenticate(request);
    return json({ok:true,features:await service.getFeatures()});
  }

  const featureToggle=url.pathname.match(/^\/api\/v1\/admin\/features\/([a-z-]+)$/);
  if(featureToggle){
    if(request.method!=='PUT')return methodNotAllowed(['PUT']);
    const actor=await authenticate(request);
    const body=await readJsonObject(request);
    return json({ok:true,...await service.setFeature(actor,featureToggle[1],body.enabled)});
  }

  const directEncryptionToggle=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/protection\/mode$/i);
  if(directEncryptionToggle){
    if(request.method!=='PUT')return methodNotAllowed(['PUT']);
    const actor=await authenticate(request);
    const body=await readJsonObject(request);
    return json({ok:true,...await service.changeDirectEncryption(actor,directEncryptionToggle[1],body.enabled)});
  }

  if (url.pathname === "/api/v1/chats") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const actor = await authenticate(request);
    const chats = await service.listChats(actor);
    return json({ ok: true, chats });
  }

  if (url.pathname === "/api/v1/chats/direct") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const body = await readJsonObject(request);
    const chat = await service.openDirectChat(actor, body.userId);
    return json({ ok: true, chat });
  }

  if (url.pathname === "/api/v1/chats/groups") {
    if(request.method!=="POST")return methodNotAllowed(["POST"]);
    const actor=await authenticate(request);
    const chat=await service.createGroup(actor,await readJsonObject(request));
    return json({ok:true,chat},{status:201});
  }

  const groupMembersMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/members$/i);
  if(groupMembersMatch){
    const actor=await authenticate(request);
    if(request.method==='GET')return json({ok:true,...await service.groupMembers(actor,groupMembersMatch[1])});
    if(request.method==='POST')return json({ok:true,...await service.addGroupMembers(actor,groupMembersMatch[1],await readJsonObject(request))});
    return methodNotAllowed(['GET','POST']);
  }

  const groupMemberMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i);
  if(groupMemberMatch){
    if(request.method!=='DELETE')return methodNotAllowed(['DELETE']);
    const actor=await authenticate(request);
    const result=await service.removeGroupMember(actor,groupMemberMatch[1],groupMemberMatch[2]);
    return json({ok:true,...result});
  }

  const envelopesMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/e2ee\/envelopes$/i);
  if(envelopesMatch){
    const actor=await authenticate(request);
    if(request.method==='POST')return json({ok:true,...await service.sendE2eeEnvelope(actor,envelopesMatch[1],await readJsonObject(request))},{status:201});
    if(request.method==='GET')return json({ok:true,...await service.fetchE2eeEnvelopes(actor,envelopesMatch[1],url.searchParams.get('deviceId')??'')});
    return methodNotAllowed(['POST','GET']);
  }
  const envelopeAck=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/e2ee\/envelopes\/([0-9a-f-]{36})\/ack$/i);
  if(envelopeAck){
    if(request.method!=='POST')return methodNotAllowed(['POST']);
    const actor=await authenticate(request);
    const body=await readJsonObject(request);
    return json({ok:true,...await service.ackE2eeEnvelope(actor,envelopeAck[1],envelopeAck[2],String(body.deviceId??''),String(body.signature??''))});
  }

  if(url.pathname==='/api/v1/e2ee/devices'){
    const actor=await authenticate(request);
    if(request.method==='GET')return json({ok:true,...await service.listOwnE2eeDevices(actor)});
    if(request.method==='POST')return json({ok:true,...await service.registerE2eeDevice(actor,await readJsonObject(request))},{status:201});
    return methodNotAllowed(['GET','POST']);
  }
  if(url.pathname==='/api/v1/e2ee/devices/approve'){
    if(request.method!=='POST')return methodNotAllowed(['POST']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.approveE2eeDevice(actor,await readJsonObject(request))});
  }
  if(url.pathname==='/api/v1/e2ee/devices/revoke'){
    if(request.method!=='POST')return methodNotAllowed(['POST']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.revokeE2eeDevice(actor,await readJsonObject(request))});
  }
  const peerDevices=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/e2ee\/devices$/i);
  if(peerDevices){
    if(request.method!=='GET')return methodNotAllowed(['GET']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.listE2eePeerDevices(actor,peerDevices[1])});
  }

  if(url.pathname==='/api/v1/keys/identity'){
    if(request.method!=='PUT')return methodNotAllowed(['PUT']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.registerAutoIdentity(actor,await readJsonObject(request))});
  }

  const autoKeysMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/keys$/i);
  if(autoKeysMatch){
    if(request.method!=='GET')return methodNotAllowed(['GET']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.autoIdentityKeys(actor,autoKeysMatch[1])});
  }

  const autoActivateMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/protection\/auto$/i);
  if(autoActivateMatch){
    if(request.method!=='POST')return methodNotAllowed(['POST']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.activateAutoProtection(actor,autoActivateMatch[1])});
  }

  const protectionMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/protection$/i);
  if(protectionMatch){
    if(request.method!=='POST')return methodNotAllowed(['POST']);
    const actor=await authenticate(request);
    return json({ok:true,...await service.enableDirectProtection(actor,protectionMatch[1])});
  }

  const deliveredMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/receipts\/delivered$/i);
  if (deliveredMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const result = await service.markDelivered(actor, deliveredMatch[1], await readJsonObject(request));
    return json({ ok: true, ...result });
  }

  const readMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/receipts\/read$/i);
  if (readMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const actor = await authenticate(request);
    const result = await service.markRead(actor, readMatch[1], await readJsonObject(request));
    return json({ ok: true, ...result });
  }

  const messagesMatch = url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/messages$/i);
  if (messagesMatch) {
    const actor = await authenticate(request);
    if (request.method === "GET") {
      const messages = await service.listMessages(actor, messagesMatch[1]);
      return json({ ok: true, messages });
    }
    if (request.method === "POST") {
      const result = await service.sendMessage(actor, messagesMatch[1], await readJsonObject(request));
      return json(
        { ok: true, ...result },
        { status: result.duplicate ? 200 : 201 }
      );
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return null;
}
