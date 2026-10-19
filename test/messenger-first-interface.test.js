import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const read = (name) => readFile(new URL(`../web/${name}`, import.meta.url), "utf8");

describe("messenger-first interface", () => {
  test("call screen is outside the conversation so incoming calls appear from the chat list", async () => {
    const html = await read("index.html");
    const css = await read("canonical-ui.css");

    expect(html).toMatch(/<\/div>\s*<section id="call-panel" class="call-banner"/);
    expect(css).toMatch(/\.call-banner:not\(\[hidden\]\)\s*\{[^}]*position:\s*fixed/s);
    expect(html).toContain('id="call-minimize"');
    expect(html).toContain('id="call-expand"');
    expect(html).toContain('id="call-dismiss"');
  });

  test("voice message quality is described in familiar language", async () => {
    const html = await read("index.html");

    expect(html).toContain('value="32000">Экономия интернета');
    expect(html).toContain('value="64000">Хорошее качество');
    expect(html).not.toContain("кбит/с");
    expect(html).toContain("Имя пользователя");
  });

  test("owner invitation is reachable directly from settings navigation", async () => {
    const html = await read("index.html");
    const ui = await read("js/ui.js");

    expect(html).toContain('id="invite-settings-link" href="#invite-title" hidden>Приглашения</a>');
    expect(ui).toContain('const canInvite = ["owner", "admin"].includes(account.role);');
    expect(ui).toContain("elements.inviteSettingsLink.hidden = !canInvite");
  });
});
