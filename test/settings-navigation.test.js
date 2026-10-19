import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const app=readFileSync(new URL("../web/app.js",import.meta.url),"utf8");
const navigation=readFileSync(new URL("../web/js/settings-screens.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../web/styles.css",import.meta.url),"utf8");

describe("real settings screens",()=>{
  test("opens a category chooser instead of one long settings feed",()=>{
    expect(app).toContain('setupSettingsScreens');
    expect(navigation).toContain('chooser.id = "settings-category-list"');
    expect(navigation).toContain('quickNavigation.hidden = true');
    expect(navigation).toContain('screens.hidden = true');
    expect(navigation).toContain('screen.hidden = true');
    expect(css).toContain('.settings-category-list');
    expect(css).toContain('.settings-screen[hidden]');
  });

  test("keeps presence in General and sensitive controls on subpages",()=>{
    expect(navigation).toContain('"presence-settings-title"');
    expect(navigation).toMatch(/password:\s*\{\s*title:\s*"Смена пароля",\s*parent:\s*"security"/);
    expect(navigation).toMatch(/microphone:\s*\{\s*title:\s*"Микрофон и качество звука",\s*parent:\s*"calls"/);
    expect(navigation).toContain('passwordScreen.append(title, passwordForm)');
    expect(navigation).toContain('page.append(microphone)');
    expect(navigation).toContain('goBackInSettings');
  });
});
