import { describe, expect, test, vi, afterEach } from "vitest";
import { logDiagnostic, diagnosticText, clearDiagnostics, subscribeDiagnostics, describeApiOperation } from "../web/js/diagnostics-log.js";
afterEach(clearDiagnostics);
describe("unified safe diagnostics", () => {
  test("logs calls, UI navigation, recording and server results in a single timeline", () => {
    const observe = vi.fn(); const off = subscribeDiagnostics(observe);
    logDiagnostic("Интерфейс", "кнопка call-answer");
    logDiagnostic("Голосовые", "запись началась", "opus 96000");
    logDiagnostic("Звонки", "звук соединён");
    logDiagnostic("Сервер", "POST ответ на звонок", "201 24 ms");
    const lines = diagnosticText().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("кнопка call-answer");
    expect(lines[1]).toContain("запись началась");
    expect(lines[3]).toContain("POST ответ на звонок");
    expect(observe).toHaveBeenCalledTimes(4);
    off();
  });
  test("never dumps unknown categories, IPs, URLs, SDP, ids, token or arbitrary user strings", () => {
    logDiagnostic("secret-user", "hello");
    for (const data of ["192.168.1.4", "https://example.com?a=password", "123e4567-e89b-12d3-a456-426614174000", "Bearer token", "abc@example.com"]) {
      logDiagnostic("Сервер", "результат", data);
    }
    const out = diagnosticText();
    expect(out).not.toContain("secret-user");
    expect(out).not.toContain("192.168");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("123e4567");
    expect(out).not.toContain("Bearer");
    expect(out).not.toContain("@example");
    expect(out).toContain("[данные скрыты]");
  });
  test("maps API paths and query strings to privacy-safe operations", () => {
    expect(describeApiOperation("/api/v1/chats/private-chat-id/calls/call-id/signals?after=400", "POST")).toBe("POST сигналы звонка");
    expect(describeApiOperation("/api/v1/chats/chat-secret/voice/uploads/secret-session/complete", "POST")).toBe("POST загрузка голосового");
    expect(describeApiOperation("/api/v1/auth/me")).toBe("GET проверка сеанса");
  });
  test("keeps bounded trace in memory", () => {
    for (let i=0;i<1100;i++) logDiagnostic("Сеть", "соединение работает");
    expect(diagnosticText().split("\n")).toHaveLength(900);
  });
});
