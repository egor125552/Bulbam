import { describe, test, expect } from 'vitest';
import { formatPresence } from '../web/js/presence-format.js';
describe('peer presence for screen readers', () => {
 test('shows online, hidden and unknown distinctly', () => {
  expect(formatPresence({ online: true, hidden: false }, 100000, 'ru')).toBe('В сети');
  expect(formatPresence({ online: false, hidden: true }, 100000, 'ru')).toBe('Статус скрыт');
  expect(formatPresence({ online: false, lastSeenAt: null }, 100000, 'ru')).toBe('Статус неизвестен');
 });
 test('formats past activity in Russian and Belarusian', () => {
  expect(formatPresence({ online: false, lastSeenAt: 100000 }, 400000, 'ru')).toContain('5 минут назад');
  expect(formatPresence({ online: false, lastSeenAt: 100000 }, 400000, 'be')).toContain('5 хвілін таму');
 });
});
