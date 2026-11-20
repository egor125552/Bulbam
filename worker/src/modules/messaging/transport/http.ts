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

  const groupManageMatch=url.pathname.match(/^\/api\/v1\/chats\/([0-9a-f-]{36})\/group-actions$/i);
  if(groupManageMatch) {
    if(request.method!=="POST")return methodNotAllowed(["POST"]);
    const actor=await authenticate(request);
    return json({ok:true,...await service.manageGroup(actor,groupManageMatch[1],await readJsonObject(request))});
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
      const rawBefore=url.searchParams.get("before");
      let before:{createdAt:number;messageId:string}|undefined;
      if(rawBefore) {
        const match=rawBefore.match(/^(\d{1,16})_([0-9a-f-]{36})$/i);
        if(!match)return json({ok:false,error:{code:"invalid_message_cursor",message:"Неверная позиция загрузки сообщений."}},{status:400});
        before={createdAt:Number(match[1]),messageId:match[2]};
      }
      const page=await service.listMessagesPage(actor,messagesMatch[1],before);
      return json({ok:true,...page});
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
