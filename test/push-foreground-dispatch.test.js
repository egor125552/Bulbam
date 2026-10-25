import {expect,test,vi} from 'vitest';
import webpush from 'web-push';
import {PushNotificationService} from '../worker/src/modules/notifications/application/push-notification-service.ts';
test('foreground activity on another session does not suppress a recipient device',async()=>{
 const send=vi.spyOn(webpush,'sendNotification').mockResolvedValue({statusCode:201});
 const repository={
   isForeground:vi.fn(async()=>true),
   listForUser:vi.fn(async()=>[{endpoint:'https://example.com/push',userId:'recipient',keys:{p256dh:'test',auth:'test'}}]),
   removeEndpoint:vi.fn()
 };
 const env={VAPID_PUBLIC_KEY:'pub',VAPID_PRIVATE_KEY:'secret',VAPID_SUBJECT:'mailto:push@example.com'};
 const service=new PushNotificationService(repository,env);
 try{
   await service.notifyNewMessage({recipientUserId:'recipient',senderDisplayName:'Паша',conversationId:'chat1',messageId:'msg1',text:'Привет'});
   expect(send).toHaveBeenCalledTimes(1);
   expect(repository.isForeground).not.toHaveBeenCalled();
 }finally{send.mockRestore();}
});
