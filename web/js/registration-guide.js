import { translateText } from "./i18n.js";
import { announce, getCurrentAccount } from "./ui.js";
import {
  REGISTRATION_GUIDE_STEPS,
  SHOWCASE_CAPABILITIES,
  clampGuideStep,
  evaluateRegistrationProgress,
  nextGuideStep,
  normalizeShowcaseCapability,
  resolveGuideResumeStep
} from "./registration-guide-core.js";

const CONTINUE_AFTER_REGISTER_KEY = "bulbam.guide.continueAfterRegister";

let currentStepIndex = 0;
let activeDockVisible = false;
let currentShowcaseId = SHOWCASE_CAPABILITIES[0].id;
let showcaseDemoPlaying = false;
let spotlightTimer = null;
let lastSpotlightElement = null;
let lastOpener = null;

function setContinueFlag(enabled) {
  try {
    if (enabled) sessionStorage.setItem(CONTINUE_AFTER_REGISTER_KEY, "1");
    else sessionStorage.removeItem(CONTINUE_AFTER_REGISTER_KEY);
  } catch {}
}

function hasContinueFlag() {
  try {
    return sessionStorage.getItem(CONTINUE_AFTER_REGISTER_KEY) === "1";
  } catch {
    return false;
  }
}

export function isRegistrationGuideContinuing() {
  return hasContinueFlag();
}

function readRegisterValues() {
  const form = document.querySelector("#register-form");
  if (!form) return { inviteCode: "", username: "", password: "" };
  return {
    inviteCode: form.querySelector('[name="inviteCode"]')?.value ?? "",
    username: form.querySelector('[name="username"]')?.value ?? "",
    password: form.querySelector('[name="password"]')?.value ?? ""
  };
}

function clearSpotlight() {
  if (spotlightTimer) {
    clearTimeout(spotlightTimer);
    spotlightTimer = null;
  }
  if (lastSpotlightElement) {
    lastSpotlightElement.classList.remove("guide-spotlight");
    lastSpotlightElement = null;
  }
}

function spotlightElement(element) {
  if (!element) return;
  clearSpotlight();
  lastSpotlightElement = element;
  element.classList.add("guide-spotlight");
  element.scrollIntoView?.({ behavior: "smooth", block: "center" });
  spotlightTimer = setTimeout(() => {
    element.classList.remove("guide-spotlight");
    if (lastSpotlightElement === element) lastSpotlightElement = null;
  }, 4200);
}

function fieldStatusLine(step, progress) {
  if (step.id === "invite") {
    return progress.inviteReady
      ? "Код приглашения уже введён. Можно переходить к следующему шагу."
      : "Поле «Код приглашения» пока пустое.";
  }
  if (step.id === "username") {
    return progress.usernameReady
      ? "Имя пользователя подходит."
      : "Введите от 3 до 32 букв, цифр или подчёркиваний без @ внутри.";
  }
  if (step.id === "password") {
    if (progress.passwordReady) return "Пароль достаточной длины. Отлично!";
    if (progress.passwordLength === 0) return "Пароль пока не введён. Минимум 10 символов.";
    const remaining = Math.max(1, 10 - progress.passwordLength);
    return `Введено символов: ${progress.passwordLength}. Добавьте ещё минимум ${remaining}.`;
  }
  if (step.id === "submit-codes") {
    return progress.allReady
      ? "Все поля заполнены! Можно нажимать «Зарегистрироваться и войти»."
      : `Заполнено полей: ${progress.completedCount} из ${progress.totalFields}. Завершите оставшиеся шаги.`;
  }
  if (step.id === "first-chat") {
    return getCurrentAccount()
      ? "Вы уже в Бульбаме! Откройте «Новый чат», чтобы начать общение."
      : "После создания аккаунта вы сразу окажетесь в списке чатов.";
  }
  return getCurrentAccount()
    ? "Всё готово к общению. Удачных звонков и переписок в Бульбаме!"
    : "Все эти возможности откроются сразу после регистрации.";
}

function el(tag, className, text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = translateText(text);
  return node;
}

function buildStepVisualElement(visual) {
  const card = el("div", `guide-visual-card guide-visual-${visual}`);
  card.setAttribute("aria-hidden", "true");

  if (visual === "invite") {
    card.append(
      el("div", "guide-mini-chip", "Одноразовый код"),
      el("div", "guide-mini-code", "BULBAM-••••-••••"),
      el("div", "guide-mini-caption", "Передаёт друг или администратор")
    );
    return card;
  }

  if (visual === "username") {
    const avatar = el("div", "guide-mini-avatar", "П");
    const lines = el("div", "guide-mini-lines");
    lines.append(
      el("strong", "", "пользователь1"),
      el("span", "", "Буквы, цифры и _ · без @ внутри")
    );
    card.append(avatar, lines);
    return card;
  }

  if (visual === "password") {
    const dots = el("div", "guide-mini-dots");
    for (let i = 0; i < 10; i += 1) dots.append(document.createElement("span"));
    const bar = el("div", "guide-mini-bar");
    bar.append(el("span", "guide-mini-bar-fill"));
    card.append(
      dots,
      bar,
      el("div", "guide-mini-caption", "Минимум 10 символов · защита аккаунта")
    );
    return card;
  }

  if (visual === "codes") {
    const grid = el("div", "guide-mini-code-grid");
    for (const sample of ["BRC-A1B2-C3D4", "BRC-E5F6-G7H8", "BRC-J9K0-L1M2", "BRC-N3P4-Q5R6"]) {
      const code = document.createElement("span");
      code.textContent = sample;
      grid.append(code);
    }
    card.append(
      grid,
      el("div", "guide-mini-caption", "8 резервных кодов показываются один раз")
    );
    return card;
  }

  if (visual === "controls") {
    const rows = [
      ["is-call", "Позвонить", "Зелёная кнопка сверху — живой звонок"],
      ["is-file", "Файл", "Скрепка слева — фото, видео, музыка"],
      ["is-voice", "Записать", "Фиолетовый микрофон — голосовое"]
    ];
    for (const [kind, badgeText, desc] of rows) {
      const row = el("div", "guide-legend-row");
      row.append(
        el("span", `guide-legend-badge ${kind}`, badgeText),
        el("span", "", desc)
      );
      card.append(row);
    }
    return card;
  }

  const wave = el("div", "guide-wave-preview");
  for (let i = 0; i < 7; i += 1) wave.append(document.createElement("span"));
  card.append(
    wave,
    el("div", "guide-mini-caption", "Звонки · Голосовые 48 кГц · Файлы 512 МБ · Face ID")
  );
  return card;
}

function renderGuideDialog() {
  const dialog = document.querySelector("#registration-guide-dialog");
  if (!dialog) return;

  const step = REGISTRATION_GUIDE_STEPS[currentStepIndex];
  const progress = evaluateRegistrationProgress(readRegisterValues());
  const signedIn = Boolean(getCurrentAccount());
  const total = REGISTRATION_GUIDE_STEPS.length;

  const counter = dialog.querySelector("#registration-guide-step-counter");
  const phaseLabel = dialog.querySelector("#registration-guide-phase");
  const title = dialog.querySelector("#registration-guide-step-title");
  const summary = dialog.querySelector("#registration-guide-step-summary");
  const tip = dialog.querySelector("#registration-guide-step-tip");
  const status = dialog.querySelector("#registration-guide-step-status");
  const stage = dialog.querySelector("#registration-guide-visual");
  const bar = dialog.querySelector("#registration-guide-progress-fill");
  const dots = dialog.querySelector("#registration-guide-dots");
  const prevButton = dialog.querySelector("#registration-guide-prev");
  const nextButton = dialog.querySelector("#registration-guide-next");
  const actionButton = dialog.querySelector("#registration-guide-action");

  if (counter) counter.textContent = translateText(`Шаг ${currentStepIndex + 1} из ${total}`);
  if (phaseLabel) {
    phaseLabel.textContent = translateText(
      step.phase === "register" ? "Регистрация" : "Знакомство с Бульбамом"
    );
  }
  if (title) title.textContent = translateText(step.title);
  if (summary) summary.textContent = translateText(step.summary);
  if (tip) tip.textContent = translateText(step.tip);
  if (status) {
    const line = fieldStatusLine(step, progress);
    status.textContent = translateText(line);
    const isPositive =
      (step.id === "invite" && progress.inviteReady) ||
      (step.id === "username" && progress.usernameReady) ||
      (step.id === "password" && progress.passwordReady) ||
      (step.id === "submit-codes" && progress.allReady);
    status.dataset.ready = isPositive ? "true" : "false";
  }
  if (stage) stage.replaceChildren(buildStepVisualElement(step.visual));
  if (bar) {
    const ratio = (currentStepIndex + 1) / total;
    bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
  }

  if (dots) {
    dots.innerHTML = "";
    REGISTRATION_GUIDE_STEPS.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "guide-step-dot";
      const done =
        (item.id === "invite" && progress.inviteReady) ||
        (item.id === "username" && progress.usernameReady) ||
        (item.id === "password" && progress.passwordReady) ||
        (item.id === "submit-codes" && progress.allReady) ||
        (signedIn && item.phase === "register");
      if (index === currentStepIndex) {
        btn.classList.add("is-current");
        btn.setAttribute("aria-current", "step");
      }
      if (done) btn.classList.add("is-done");
      btn.setAttribute("aria-label", translateText(`Шаг ${index + 1}: ${item.title}`));
      btn.textContent = String(index + 1);
      btn.addEventListener("click", () => {
        currentStepIndex = index;
        renderGuideDialog();
        renderGuideDock();
      });
      dots.append(btn);
    });
  }

  if (prevButton) prevButton.disabled = currentStepIndex === 0;
  if (nextButton) {
    const isLast = currentStepIndex === total - 1;
    nextButton.textContent = translateText(
      isLast ? (signedIn ? "Начать общение" : "Перейти к регистрации") : "Дальше"
    );
  }
  if (actionButton) {
    const canAct =
      (step.phase === "register" && !signedIn) ||
      (step.phase === "acquaintance" && signedIn);
    actionButton.hidden = !canAct;
    if (canAct) actionButton.textContent = translateText(step.actionLabel);
  }
}

function renderGuideDock() {
  const dock = document.querySelector("#registration-guide-dock");
  if (!dock) return;
  const registerView = document.querySelector("#auth-view-register");
  const signedIn = Boolean(getCurrentAccount());
  const shouldShow = activeDockVisible && !signedIn && registerView && !registerView.hidden;
  dock.hidden = !shouldShow;
  if (!shouldShow) return;

  const progress = evaluateRegistrationProgress(readRegisterValues());
  const stepIndex = Math.min(currentStepIndex, 3);
  const step = REGISTRATION_GUIDE_STEPS[stepIndex];

  const badge = dock.querySelector("#guide-dock-step");
  const text = dock.querySelector("#guide-dock-status");
  const nextBtn = dock.querySelector("#guide-dock-next");

  if (badge) badge.textContent = translateText(`Шаг ${stepIndex + 1} из 6 · ${step.title}`);
  if (text) text.textContent = translateText(fieldStatusLine(step, progress));
  if (nextBtn) {
    nextBtn.textContent = translateText(stepIndex >= 3 ? "Показать знакомство" : "Следующий шаг");
  }
}

export function openRegistrationGuide(stepIndex = null, opener = null) {
  const dialog = document.querySelector("#registration-guide-dialog");
  if (!dialog) return;

  lastOpener = opener ?? document.activeElement;
  const signedIn = Boolean(getCurrentAccount());
  if (stepIndex !== null) {
    currentStepIndex = clampGuideStep(stepIndex);
  } else if (signedIn) {
    currentStepIndex = 4;
  } else {
    const progress = evaluateRegistrationProgress(readRegisterValues());
    currentStepIndex = progress.nextIncompleteStepIndex;
  }

  if (!signedIn) setContinueFlag(true);
  renderGuideDialog();

  if (!dialog.open) dialog.showModal();
  dialog.querySelector("#registration-guide-step-title")?.focus();
  const step = REGISTRATION_GUIDE_STEPS[currentStepIndex];
  announce(`Пошаговый гид. Шаг ${currentStepIndex + 1} из ${REGISTRATION_GUIDE_STEPS.length}: ${step.title}`);
}

function performStepAction() {
  const dialog = document.querySelector("#registration-guide-dialog");
  const step = REGISTRATION_GUIDE_STEPS[currentStepIndex];
  const signedIn = Boolean(getCurrentAccount());

  if (step.phase === "register" && !signedIn) {
    activeDockVisible = true;
    setContinueFlag(true);
    dialog?.close();
    renderGuideDock();

    const form = document.querySelector("#register-form");
    if (!form) return;
    let target = null;
    if (step.fieldName === "submit") {
      target = form.querySelector('button[type="submit"]');
    } else if (step.fieldName) {
      target = form.querySelector(`[name="${step.fieldName}"]`);
    }
    if (target) {
      spotlightElement(target);
      target.focus();
    }
    return;
  }

  if (step.phase === "acquaintance" && signedIn && step.targetSelector) {
    dialog?.close();
    const target = document.querySelector(step.targetSelector);
    if (target) {
      spotlightElement(target);
      target.focus();
      if (step.targetSelector === "#settings-button") {
        target.click();
      }
    }
  }
}

function schedulePostRegisterAcquaintance() {
  const resumeStep = resolveGuideResumeStep({
    isSignedIn: Boolean(getCurrentAccount()),
    wantsContinue: hasContinueFlag()
  });
  if (resumeStep === null) return;

  const dialog = document.querySelector("#registration-guide-dialog");
  if (!dialog || dialog.open) return;

  const blocking = [...document.querySelectorAll("dialog[open]")].find((other) => other !== dialog);
  if (blocking) {
    blocking.addEventListener("close", () => setTimeout(schedulePostRegisterAcquaintance, 160), { once: true });
    return;
  }

  setContinueFlag(false);
  activeDockVisible = false;
  renderGuideDock();
  openRegistrationGuide(resumeStep);
}

function renderShowcase(capabilityId) {
  const showcase = document.querySelector("#auth-showcase");
  if (!showcase) return;
  currentShowcaseId = normalizeShowcaseCapability(capabilityId);
  const active = SHOWCASE_CAPABILITIES.find((item) => item.id === currentShowcaseId) ?? SHOWCASE_CAPABILITIES[0];

  for (const tab of showcase.querySelectorAll("[data-showcase-tab]")) {
    const selected = tab.dataset.showcaseTab === active.id;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle("is-active", selected);
  }

  for (const stage of showcase.querySelectorAll("[data-showcase-stage]")) {
    stage.hidden = stage.dataset.showcaseStage !== active.id;
  }

  const kicker = showcase.querySelector("#showcase-kicker");
  const title = showcase.querySelector("#showcase-title");
  const description = showcase.querySelector("#showcase-description");
  const cue = showcase.querySelector("#showcase-cue");

  if (kicker) kicker.textContent = translateText(active.kicker);
  if (title) title.textContent = translateText(active.title);
  if (description) description.textContent = translateText(active.description);
  if (cue) cue.textContent = translateText(active.cueLabel);
}

function setupShowcase() {
  const showcase = document.querySelector("#auth-showcase");
  if (!showcase) return;

  const tabs = [...showcase.querySelectorAll("[data-showcase-tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      renderShowcase(tab.dataset.showcaseTab);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      renderShowcase(next.dataset.showcaseTab);
      next.focus();
    });
  });

  const demoToggle = showcase.querySelector("#showcase-demo-toggle");
  demoToggle?.addEventListener("click", () => {
    showcaseDemoPlaying = !showcaseDemoPlaying;
    showcase.classList.toggle("is-demo-playing", showcaseDemoPlaying);
    demoToggle.setAttribute("aria-pressed", showcaseDemoPlaying ? "true" : "false");
    demoToggle.textContent = translateText(
      showcaseDemoPlaying ? "Пауза предпросмотра" : "Оживить предпросмотр"
    );
  });

  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("page-hidden", document.hidden);
  });

  renderShowcase(currentShowcaseId);
}

export function setupRegistrationGuide() {
  setupShowcase();

  const launchButton = document.querySelector("#auth-register-guide-button");
  const emptyGuideButton = document.querySelector("#open-acquaintance-guide");
  const welcomeGuideButton = document.querySelector("#welcome-open-guide");
  const dialog = document.querySelector("#registration-guide-dialog");
  const closeButton = document.querySelector("#registration-guide-close");
  const prevButton = document.querySelector("#registration-guide-prev");
  const nextButton = document.querySelector("#registration-guide-next");
  const actionButton = document.querySelector("#registration-guide-action");

  const dockOpen = document.querySelector("#guide-dock-open");
  const dockNext = document.querySelector("#guide-dock-next");
  const dockHide = document.querySelector("#guide-dock-hide");

  launchButton?.addEventListener("click", () => openRegistrationGuide(null, launchButton));
  emptyGuideButton?.addEventListener("click", () => openRegistrationGuide(4, emptyGuideButton));
  welcomeGuideButton?.addEventListener("click", () => {
    document.querySelector("#bulbam-welcome-dialog")?.close();
    openRegistrationGuide(4, welcomeGuideButton);
  });

  closeButton?.addEventListener("click", () => dialog?.close());

  prevButton?.addEventListener("click", () => {
    currentStepIndex = nextGuideStep(currentStepIndex, -1);
    renderGuideDialog();
    renderGuideDock();
    const step = REGISTRATION_GUIDE_STEPS[currentStepIndex];
    announce(`Шаг ${currentStepIndex + 1} из ${REGISTRATION_GUIDE_STEPS.length}: ${step.title}`);
  });

  nextButton?.addEventListener("click", () => {
    const isLast = currentStepIndex === REGISTRATION_GUIDE_STEPS.length - 1;
    if (isLast) {
      dialog?.close();
      if (getCurrentAccount()) {
        document.querySelector("#chats-title")?.focus();
      } else {
        activeDockVisible = true;
        renderGuideDock();
        const progress = evaluateRegistrationProgress(readRegisterValues());
        const step = REGISTRATION_GUIDE_STEPS[progress.nextIncompleteStepIndex];
        const target = step.fieldName === "submit"
          ? document.querySelector('#register-form button[type="submit"]')
          : document.querySelector(`#register-form [name="${step.fieldName}"]`);
        if (target) {
          spotlightElement(target);
          target.focus();
        }
      }
      return;
    }
    currentStepIndex = nextGuideStep(currentStepIndex, 1);
    renderGuideDialog();
    renderGuideDock();
    const step = REGISTRATION_GUIDE_STEPS[currentStepIndex];
    announce(`Шаг ${currentStepIndex + 1} из ${REGISTRATION_GUIDE_STEPS.length}: ${step.title}`);
  });

  actionButton?.addEventListener("click", performStepAction);

  dockOpen?.addEventListener("click", () => openRegistrationGuide(currentStepIndex, dockOpen));
  dockNext?.addEventListener("click", () => {
    if (currentStepIndex >= 3) {
      openRegistrationGuide(4, dockNext);
      return;
    }
    currentStepIndex = nextGuideStep(currentStepIndex, 1);
    renderGuideDock();
    const step = REGISTRATION_GUIDE_STEPS[currentStepIndex];
    const form = document.querySelector("#register-form");
    const target = step.fieldName === "submit"
      ? form?.querySelector('button[type="submit"]')
      : form?.querySelector(`[name="${step.fieldName}"]`);
    if (target) {
      spotlightElement(target);
      target.focus();
    }
    announce(`Шаг ${currentStepIndex + 1}: ${step.title}`);
  });
  dockHide?.addEventListener("click", () => {
    activeDockVisible = false;
    clearSpotlight();
    renderGuideDock();
  });

  dialog?.addEventListener("close", () => {
    if (lastOpener && document.contains(lastOpener) && !activeDockVisible) {
      lastOpener.focus?.();
    }
    lastOpener = null;
  });

  const registerForm = document.querySelector("#register-form");
  registerForm?.addEventListener("input", () => {
    if (dialog?.open) renderGuideDialog();
    if (activeDockVisible) renderGuideDock();
  });

  window.addEventListener("bulbam:language-changed", () => {
    renderShowcase(currentShowcaseId);
    if (dialog?.open) renderGuideDialog();
    if (activeDockVisible) renderGuideDock();
  });

  window.addEventListener("bulbam:registered", () => {
    if (hasContinueFlag()) {
      setTimeout(schedulePostRegisterAcquaintance, 220);
    }
  });

  window.addEventListener("bulbam:account-changed", (event) => {
    if (!event.detail?.account) {
      clearSpotlight();
      return;
    }
    if (hasContinueFlag()) {
      setTimeout(schedulePostRegisterAcquaintance, 350);
    }
  });
}
