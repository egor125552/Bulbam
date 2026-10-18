import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("session checks do not pretend accounts were deleted", () => {
  test("transient failures offer retry instead of falsely claiming logout", async () => {
    const auth=await readFile(new URL("../web/js/auth.js",import.meta.url),"utf8");
    const code=auth.slice(auth.indexOf("export async function loadCurrentAccount"),auth.indexOf("async function register"));
    expect(code).toContain('if (error.status === 401)');
    expect(code).toContain("getCurrentAccount()");
    expect(code).toContain("showAuthCheckProblem()");
    expect(code).toContain("Попробуйте проверить вход ещё раз");
  });
  test("recheck button works with VoiceOver and existing login remains available", async () => {
    const html=await readFile(new URL("../web/index.html",import.meta.url),"utf8");
    expect(html).toContain('id="auth-connection-problem"');
    expect(html).toContain('id="auth-retry"');
    expect(html).toContain('role="status"');
  });
});
