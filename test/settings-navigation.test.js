import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { recordingStartText } from "../web/js/accessibility-options.js";
import { be } from "../web/js/locales/be.js";

const html=readFileSync(new URL("../web/index.html",import.meta.url),"utf8");
const navigation=readFileSync(new URL("../web/js/settings-screens.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../web/styles.css",import.meta.url),"utf8");

describe("VoiceOver-first settings screens",()=>{
  test("the chooser opens with no selected screen and password is a private subpage",()=>{
    expect(navigation).toContain('screens.hidden = true');
    expect(navigation).toContain('screen.hidden = true');
    expect(navigation).toContain('SUBPAGES');
    expect(navigation).toContain('password: { title:"Смена пароля", parent:"security" }');
    expect(navigation).toContain('microphone: { title:"Микрофон", parent:"calls" }');
    expect(navigation).toContain('passwordScreen.append(title, passwordForm)');
    expect(navigation).toContain('page.append(microphone)');
    expect(navigation).toContain('chooser.hidden = true');
    expect(navigation).toContain('goBackInSettings');
    expect(css).toMatch(/\.settings-dialog\s*\{[^}]*height:\s*100dvh/s);
  });
  test("preserves original secure controls and adds real global accessibility preferences",()=>{
    expect(html).toContain('id="change-password-form"');
    expect(html).toContain('id="refresh-passkeys"');
    expect(html).toContain('id="refresh-sessions"');
    expect(html).toContain('id="settings-detailed-help"');
    expect(html).toContain('id="settings-simple-controls"');
    expect(css).toContain('[data-detailed-help="off"]');
    expect(css).toContain('[data-essential-hint]');
  });
  test("short VoiceOver instructions apply at the shared accessibility level",()=>{
    expect(recordingStartText(false,"button")).toBe("Запись началась.");
    expect(recordingStartText(false,"option")).toBe("Запись началась.");
    expect(recordingStartText(true,"button")).toMatch(/Нажми кнопку/);
  });
  test("new settings labels are localized",()=>{
    for(const term of [
      "Категории настроек","Выберите категорию","Основные",
      "Смена пароля","Микрофон и качество звука",
      "Простые кнопки без раскрывающихся списков",
      "Подробные подсказки во всём Бульбаме"
    ])expect(be[term]).toBeTruthy();
  });
});
