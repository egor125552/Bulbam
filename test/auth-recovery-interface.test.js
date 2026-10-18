import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { describe, expect, test } from "vitest";

async function html() {
  return readFile(new URL("../web/index.html",import.meta.url),"utf8");
}

describe("accessible authentication and password recovery",()=>{
  test("auth JavaScript parses as a standards-compliant browser module",async()=>{
    const source=await readFile(new URL("../web/js/auth.js",import.meta.url),"utf8");
    const result=await transform(source,{loader:"js",format:"esm",target:"es2022"});
    expect(result.code).toContain("function showAuthView");
  });

  test("login is the only initial auth form; register and forgot password are explicit views",async()=>{
    const page=await html();
    expect(page).toContain('id="auth-view-login"');
    expect(page).toContain('id="auth-view-register" class="card auth-card" hidden');
    expect(page).toContain('id="auth-view-recovery" class="card auth-card" hidden');
    expect(page).toContain('id="auth-register-button"');
    expect(page).toContain('id="auth-forgot-button"');
    expect(page).toContain('id="auth-login-from-recovery"');
    expect(page).toContain('id="auth-login-from-register"');
    expect(page).toContain('id="auth-session-note" class="hint" role="status" hidden');
  });
  test("recovery form is properly labelled and registration requires no additional login",async()=>{
    const page=await html();
    for(const name of ["username","code","newPassword","confirmPassword"]){
      expect(page).toContain('name="'+name+'"');
    }
    expect(page).toContain('id="recovery-form"');
    expect(page).toContain('id="recovery-codes-dialog" aria-labelledby="recovery-codes-title"');
    expect(page).toContain('id="recovery-codes-text"');
    expect(page).toContain('id="change-password-form"');
    expect(page).toContain('id="new-recovery-codes"');
    const auth=await readFile(new URL("../web/js/auth.js",import.meta.url),"utf8");
    expect(auth).toContain('showSignedIn(result.account, result.session)');
    expect(auth).toContain('showRecoveryCodes(result.recoveryCodes)');
  });
});