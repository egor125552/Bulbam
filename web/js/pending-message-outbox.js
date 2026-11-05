export function createPendingMessageOutbox(){
  const byConversation=new Map();
  return {
    clear(){byConversation.clear();},
    add(message){
      const id=message.conversationId;
      if(!byConversation.has(id))byConversation.set(id,new Map());
      byConversation.get(id).set(message.clientMessageId,message);
    },
    remove(message){byConversation.get(message.conversationId)?.delete(message.clientMessageId);},
    forConversation(id){return [...(byConversation.get(id)?.values()??[])];}
  };
}
export function isDisplayedConversation(current,message){
  return Boolean(current && message?.conversationId===current.conversationId);
}
