import {test,expect} from 'vitest';
import {chatPreviewForConversation,chatLatestTime} from '../web/js/chat-presentation.js';

test('a new encrypted message replaces a stale plaintext preview and time',()=>{
 const chat={kind:'direct',lastMessageAt:2000,
  lastMessage:{text:'Старое сообщение',createdAt:1000,senderUserId:'alice'}};
 expect(chatPreviewForConversation(chat,'bob')).toBe('Сообщение');
 expect(chatLatestTime(chat)).toBe(2000);
});
test('normal previews and voice notes remain unchanged',()=>{
 const chat={kind:'direct',lastMessageAt:1000,
  lastMessage:{text:'Старое сообщение',createdAt:1000,senderUserId:'alice'}};
 expect(chatPreviewForConversation(chat,'bob')).toBe('Старое сообщение');
 expect(chatLatestTime(chat)).toBe(1000);
});
