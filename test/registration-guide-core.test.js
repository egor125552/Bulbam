import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  REGISTRATION_GUIDE_STEPS,
  SHOWCASE_CAPABILITIES,
  clampGuideStep,
  evaluateRegistrationProgress,
  nextGuideStep,
  normalizeShowcaseCapability,
  resolveGuideResumeStep
} from "../web/js/registration-guide-core.js";

describe("registration guide and capability showcase logic", () => {
  test("defines 6 sequential steps covering both registration and post-signup acquaintance", () => {
    expect(REGISTRATION_GUIDE_STEPS).toHaveLength(6);
    const registerSteps = REGISTRATION_GUIDE_STEPS.filter((s) => s.phase === "register");
    const acquaintanceSteps = REGISTRATION_GUIDE_STEPS.filter((s) => s.phase === "acquaintance");
    expect(registerSteps).toHaveLength(4);
    expect(acquaintanceSteps).toHaveLength(2);
  });

  test("evaluates live registration readiness and picks the next incomplete step", () => {
    const empty = evaluateRegistrationProgress({ inviteCode: "", username: "", password: "" });
    expect(empty.allReady).toBe(false);
    expect(empty.completedCount).toBe(0);
    expect(empty.nextIncompleteStepIndex).toBe(0);

    const withInvite = evaluateRegistrationProgress({
      inviteCode: "BULBAM-1234",
      username: "ab",
      password: "short"
    });
    expect(withInvite.inviteReady).toBe(true);
    expect(withInvite.usernameReady).toBe(false);
    expect(withInvite.passwordReady).toBe(false);
    expect(withInvite.nextIncompleteStepIndex).toBe(1);

    const withUsername = evaluateRegistrationProgress({
      inviteCode: "BULBAM-1234",
      username: "@пользователь_1",
      password: "123456789"
    });
    expect(withUsername.usernameReady).toBe(true);
    expect(withUsername.passwordReady).toBe(false);
    expect(withUsername.passwordLength).toBe(9);
    expect(withUsername.nextIncompleteStepIndex).toBe(2);

    const complete = evaluateRegistrationProgress({
      inviteCode: "BULBAM-1234",
      username: "егорушка_15",
      password: "super-strong-password"
    });
    expect(complete.allReady).toBe(true);
    expect(complete.completedCount).toBe(3);
    expect(complete.nextIncompleteStepIndex).toBe(3);
  });

  test("rejects @ inside username in live guide check", () => {
    const invalid = evaluateRegistrationProgress({
      inviteCode: "BULBAM-1234",
      username: "user@domain",
      password: "super-strong-password"
    });
    expect(invalid.usernameReady).toBe(false);
  });

  test("clamps and steps guide navigation safely", () => {
    expect(clampGuideStep(-5)).toBe(0);
    expect(clampGuideStep(99)).toBe(REGISTRATION_GUIDE_STEPS.length - 1);
    expect(nextGuideStep(0, -1)).toBe(0);
    expect(nextGuideStep(0, 1)).toBe(1);
    expect(nextGuideStep(5, 1)).toBe(5);
  });

  test("resumes seamlessly at the acquaintance phase after registration completes", () => {
    expect(resolveGuideResumeStep({ isSignedIn: false, wantsContinue: true })).toBeNull();
    expect(resolveGuideResumeStep({ isSignedIn: true, wantsContinue: false })).toBeNull();
    const resumeIndex = resolveGuideResumeStep({ isSignedIn: true, wantsContinue: true });
    expect(resumeIndex).toBe(4);
    expect(REGISTRATION_GUIDE_STEPS[resumeIndex].phase).toBe("acquaintance");
  });

  test("normalizes interactive showcase capability IDs", () => {
    expect(SHOWCASE_CAPABILITIES.map((c) => c.id)).toEqual(["voice", "calls", "files", "security"]);
    expect(normalizeShowcaseCapability("calls")).toBe("calls");
    expect(normalizeShowcaseCapability("unknown")).toBe("voice");
  });

  test("keeps required guide button, dialog, showcase and Liquid Glass cues in HTML", async () => {
    const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    expect(html).toContain('id="auth-register-guide-button"');
    expect(html).toContain("Не знаете, как зарегистрироваться?");
    expect(html).toContain('id="registration-guide-dialog"');
    expect(html).toContain('id="registration-guide-dock"');
    expect(html).toContain('id="auth-showcase"');
    expect(html).toContain('id="open-acquaintance-guide"');
  });
});
