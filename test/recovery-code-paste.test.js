import { describe, expect, test } from "vitest";
import { extractRecoveryCodes, firstRecoveryCode, setupRecoveryCodeSmartPaste } from "../web/js/recovery-code-paste.js";

const first = "BRC-AAAAAA-BBBBBB-CCCCCC-DDDDDD";
const second = "BRC-111111-222222-333333-444444";
const eight = [first, second, ...Array.from({length:6},(_,i) =>
  "BRC-"+String(i+1).repeat(6)+"-AAAAAA-BBBBBB-CCCCCC")];

function inputMock(){
  const input=new EventTarget();
  input.value="";
  return input;
}
describe("безопасная вставка резервного кода",()=>{
  test("находит один код в произвольном тексте и принимает Unicode-тире",()=>{
    expect(firstRecoveryCode("Код восстановления:\n"+first+"\nСохраните его.")).toBe(first);
    expect(firstRecoveryCode(first.toLowerCase())).toBe(first);
    expect(firstRecoveryCode(first.replaceAll("-","–"))).toBe(first);
    expect(firstRecoveryCode(first.replaceAll("-","‑"))).toBe(first);
  });
  test("из восьми кодов выбирает только первый, без перебора",()=>{
    expect(extractRecoveryCodes(eight.join("\n"))).toEqual(eight);
    expect(firstRecoveryCode(eight.join("\n"))).toBe(first);
    expect(extractRecoveryCodes("Нет кодов")).toEqual([]);
  });
  test("не принимает неполные или расширенные коды",()=>{
    expect(firstRecoveryCode("BRC-AAAAAA-BBBBBB-CCCCCC-DDDDD")).toBeNull();
    expect(firstRecoveryCode("X"+first)).toBeNull();
    expect(firstRecoveryCode(first+"-AAAA")).toBeNull();
    expect(firstRecoveryCode("BRC-123456-789ABC-DEF012-34567X")).toBeNull();
  });
  test("при вставке отправляет в поле только первый и не озвучивает секреты",()=>{
    const input=inputMock(),feedback={textContent:""};
    const detach=setupRecoveryCodeSmartPaste(input,feedback);
    const event=new Event("paste",{cancelable:true});
    Object.defineProperty(event,"clipboardData",{value:{getData:()=>eight.join("\n")}});
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe(first);
    expect(feedback.textContent).toContain("Остальные не отправлены");
    expect(feedback.textContent).not.toContain(first);
    expect(feedback.textContent).not.toContain(second);
    detach();
  });
  test("срабатывает при вставке в Safari без clipboardData",()=>{
    const input=inputMock(),feedback={textContent:""};
    setupRecoveryCodeSmartPaste(input,feedback);
    input.value="Восстановление\n"+first+"\n"+second;
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe(first);
    expect(feedback.textContent).toContain("первый");
  });
  test("один код и ручной ввод не вызывают неожиданных изменений",()=>{
    const input=inputMock(),feedback={textContent:""};
    setupRecoveryCodeSmartPaste(input,feedback);
    input.value="BRC-AAAAAA-";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("BRC-AAAAAA-");
    input.value=first;
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe(first);
    expect(feedback.textContent).toBe("");
  });
  test("обработчик можно отключить без побочных эффектов",()=>{
    const input=inputMock(),feedback={textContent:""};
    const detach=setupRecoveryCodeSmartPaste(input,feedback);
    detach();
    input.value=eight.join("\n");
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe(eight.join("\n"));
  });
});