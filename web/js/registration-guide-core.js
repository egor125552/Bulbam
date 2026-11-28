// Pure state and validation helpers for the step-by-step registration &
// acquaintance walkthrough and the signed-out interactive capability showcase.

const USERNAME_PATTERN = /^[a-z0-9_\p{Script=Cyrillic}]{3,32}$/u;

export const SHOWCASE_CAPABILITIES = Object.freeze([
  {
    id: "chats",
    tabLabel: "Чаты",
    kicker: "Личные диалоги и группы",
    title: "Переписка, где всё под рукой",
    description: "Создавайте группы, отвечайте на сообщения, редактируйте отправленное, ставьте реакции, сохраняйте важное в избранное, пересылайте и открывайте ссылки прямо из чата.",
    cueLabel: "Кнопка меню действий есть у каждого сообщения"
  },
  {
    id: "voice",
    tabLabel: "Голосовые",
    kicker: "Чистый звук 48 кГц",
    title: "Голосовые студийного качества",
    description: "Записывайте без искажений, ставьте запись на паузу, ускоряйте прослушивание и слушайте с того места, где остановились.",
    cueLabel: "Кнопка микрофона справа внизу чата"
  },
  {
    id: "calls",
    tabLabel: "Звонки",
    kicker: "1-на-1, группы и слабая сеть",
    title: "Личные и групповые звонки без лишних обрывов",
    description: "Выбирайте, кому именно позвонить в группе, переносите разговор между устройствами через «Бульбам Пераход» и говорите стабильно даже на слабом интернете с автоподстройкой битрейта.",
    cueLabel: "Зелёная кнопка «Позвонить» в шапке чата"
  },
  {
    id: "files",
    tabLabel: "Файлы",
    kicker: "До 512 МБ на полной скорости",
    title: "Фото, видео, музыка и любые файлы",
    description: "Отправляйте большие файлы с процентами и скоростью загрузки. Фото открываются на весь экран, видео и музыка играют прямо внутри чата, а ссылки в подписях сразу кликабельны.",
    cueLabel: "Кнопка скрепки слева от поля ввода"
  },
  {
    id: "security",
    tabLabel: "Защита",
    kicker: "Ключи доступа и VoiceOver",
    title: "Вход по Face ID и полная доступность",
    description: "Создайте ключ доступа для входа без пароля, управляйте активными устройствами, сохраните резервные коды и выберите удобный режим чтения сообщений для VoiceOver и клавиатуры.",
    cueLabel: "Раздел «Настройки → Безопасность»"
  }
]);

export const REGISTRATION_GUIDE_STEPS = Object.freeze([
  {
    id: "invite",
    phase: "register",
    fieldName: "inviteCode",
    visual: "invite",
    title: "Получите код приглашения",
    summary: "Бульбам — закрытый мессенджер. Для нового аккаунта нужен одноразовый код приглашения от друга или администратора.",
    tip: "Скопируйте код целиком без лишних пробелов и вставьте его в поле «Код приглашения».",
    actionLabel: "Перейти к полю кода"
  },
  {
    id: "username",
    phase: "register",
    fieldName: "username",
    visual: "username",
    title: "Придумайте имя пользователя",
    summary: "По этому логину вас смогут находить собеседники. Подойдут от 3 до 32 русских, белорусских или латинских букв, цифр и подчёркиваний.",
    tip: "Символ @ в начале писать не нужно, а внутри имени пользователя он запрещён. Пример: пользователь1.",
    actionLabel: "Заполнить имя пользователя"
  },
  {
    id: "password",
    phase: "register",
    fieldName: "password",
    visual: "password",
    title: "Задайте надёжный пароль",
    summary: "Пароль должен быть не короче 10 символов. Лучше использовать фразу из нескольких слов с цифрами — её легко запомнить и трудно подобрать.",
    tip: "После входа вы сможете добавить ключ доступа (Face ID или Touch ID), чтобы входить в одно касание.",
    actionLabel: "Перейти к полю пароля"
  },
  {
    id: "submit-codes",
    phase: "register",
    fieldName: "submit",
    visual: "codes",
    title: "Создайте аккаунт и сохраните коды",
    summary: "Нажмите «Зарегистрироваться и войти». Сразу после этого Бульбам покажет 8 одноразовых резервных кодов — обязательно сохраните их в надёжном месте.",
    tip: "После сохранения кодов можно задать красивое отображаемое имя, а затем гид автоматически продолжит знакомство внутри чата.",
    actionLabel: "Перейти к кнопке регистрации"
  },
  {
    id: "first-chat",
    phase: "acquaintance",
    targetSelector: "#new-chat-button",
    visual: "controls",
    title: "Найдите собеседника и управляйте сообщениями",
    summary: "Нажмите «Новый чат», найдите человека или создайте группу. У каждого сообщения есть меню действий: ответ, редактирование, реакции, пересылка, избранное и удаление. Ссылки в тексте открываются сразу.",
    tip: "В шапке чата зелёная трубка запускает личный или выборочный групповой звонок, скрепка слева прикрепляет файлы, а микрофон справа записывает голосовое.",
    actionLabel: "Показать кнопку «Новый чат»"
  },
  {
    id: "superpowers",
    phase: "acquaintance",
    targetSelector: "#settings-button",
    visual: "superpowers",
    title: "Групповые звонки, файлы, VoiceOver и защита",
    summary: "Звоните 1-на-1 или выбирайте участников в группе, переносите звонок между устройствами через «Бульбам Пераход», отправляйте файлы до 512 МБ и записывайте голосовые 48 кГц.",
    tip: "Откройте «Настройки», чтобы включить уведомления, выбрать режим чтения сообщений для VoiceOver, добавить ключ доступа и проверить активные устройства.",
    actionLabel: "Открыть настройки"
  }
]);

export function canonicalGuideUsername(raw) {
  return String(raw ?? "").normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
}

export function evaluateRegistrationProgress({ inviteCode = "", username = "", password = "" } = {}) {
  const cleanInvite = String(inviteCode ?? "").trim();
  const cleanUsername = canonicalGuideUsername(username);
  const rawPassword = String(password ?? "");

  const inviteReady = cleanInvite.length >= 4;
  const usernameReady = USERNAME_PATTERN.test(cleanUsername);
  const passwordLength = rawPassword.length;
  const passwordReady = passwordLength >= 10 && passwordLength <= 128;

  const completedCount = Number(inviteReady) + Number(usernameReady) + Number(passwordReady);
  const allReady = inviteReady && usernameReady && passwordReady;

  let nextIncompleteStepIndex = 3;
  if (!inviteReady) nextIncompleteStepIndex = 0;
  else if (!usernameReady) nextIncompleteStepIndex = 1;
  else if (!passwordReady) nextIncompleteStepIndex = 2;

  return {
    inviteReady,
    usernameReady,
    passwordReady,
    passwordLength,
    completedCount,
    totalFields: 3,
    allReady,
    nextIncompleteStepIndex
  };
}

export function clampGuideStep(index, total = REGISTRATION_GUIDE_STEPS.length) {
  const numeric = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, numeric));
}

export function nextGuideStep(current, delta, total = REGISTRATION_GUIDE_STEPS.length) {
  return clampGuideStep(clampGuideStep(current, total) + delta, total);
}

export function resolveGuideResumeStep({ isSignedIn = false, wantsContinue = false } = {}) {
  if (!isSignedIn || !wantsContinue) return null;
  const idx = REGISTRATION_GUIDE_STEPS.findIndex((step) => step.phase === "acquaintance");
  return idx >= 0 ? idx : null;
}

export function normalizeShowcaseCapability(id) {
  const found = SHOWCASE_CAPABILITIES.find((item) => item.id === id);
  return found ? found.id : SHOWCASE_CAPABILITIES[0].id;
}
