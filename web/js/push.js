import { api } from "./api.js";
import { announce, elements, getCurrentAccount } from "./ui.js";

let registrationPromise = null;
let config = null;

export function setupPushNotifications() {
  elements.pushEnableButton.addEventListener("click", () => void enablePush());
  elements.pushDisableButton.addEventListener("click", () => void disablePush());

  window.addEventListener("bulbam:account-changed", () => {
    void refreshPushState();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void clearBadge();
  });

  if (pushSupported()) {
    registrationPromise = navigator.serviceWorker.register("/sw.js");
  }
}

export async function detachPushSubscription() {
  if (!pushSupported() || !getCurrentAccount()) return;
  try {
    const registration = await ensureRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await api("/api/v1/push/subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
  } catch {
    // Logout must still be possible if a push service or network is unavailable.
  }
}

async function refreshPushState() {
  const account = getCurrentAccount();
  if (!account) {
    setUi("Войдите в аккаунт, чтобы настроить уведомления.", false, false);
    return;
  }

  if (!pushSupported()) {
    setUi("Этот браузер не поддерживает Web Push для Бульбама.", false, false);
    return;
  }

  if (isIosFamily() && !isStandalone()) {
    setUi(
      "На iPhone или iPad сначала добавьте Бульбам на экран Домой и откройте его как приложение.",
      false,
      false
    );
    return;
  }

  try {
    config = await api("/api/v1/push/config");
    if (!config.configured || !config.vapidPublicKey) {
      setUi("Сервер push-уведомлений ещё не настроен.", false, false);
      return;
    }

    const registration = await ensureRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (Notification.permission === "granted" && subscription) {
      await syncSubscription(subscription);
      setUi("Push-уведомления включены на этом устройстве.", false, true);
      return;
    }

    if (Notification.permission === "denied") {
      setUi("Уведомления запрещены в настройках браузера или системы.", false, false);
      return;
    }

    setUi("Push-уведомления выключены на этом устройстве.", true, false);
  } catch (error) {
    setUi(`Не удалось проверить push-уведомления: ${error.message}`, true, false);
  }
}

async function enablePush() {
  if (!getCurrentAccount() || !pushSupported()) return;
  elements.pushEnableButton.disabled = true;
  try {
    config = config ?? await api("/api/v1/push/config");
    if (!config.configured || !config.vapidPublicKey) {
      throw new Error("сервер push-уведомлений ещё не настроен");
    }

    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") {
      setUi("Разрешение на уведомления не выдано.", permission !== "denied", false);
      announce("Уведомления не включены.");
      return;
    }

    const registration = await ensureRegistration();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(config.vapidPublicKey)
      });
    }

    await syncSubscription(subscription);
    setUi("Push-уведомления включены на этом устройстве.", false, true);
    announce("Push-уведомления Бульбама включены.");
  } catch (error) {
    setUi(`Не удалось включить уведомления: ${error.message}`, true, false);
    announce(`Не удалось включить уведомления: ${error.message}`);
  } finally {
    elements.pushEnableButton.disabled = false;
  }
}

async function disablePush() {
  elements.pushDisableButton.disabled = true;
  try {
    const registration = await ensureRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      try {
        await api("/api/v1/push/subscription", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
      } finally {
        await subscription.unsubscribe();
      }
    }
    await clearBadge();
    setUi("Push-уведомления выключены на этом устройстве.", true, false);
    announce("Push-уведомления Бульбама отключены.");
  } catch (error) {
    setUi(`Не удалось отключить уведомления: ${error.message}`, false, true);
    announce(`Не удалось отключить уведомления: ${error.message}`);
  } finally {
    elements.pushDisableButton.disabled = false;
  }
}

async function syncSubscription(subscription) {
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys?.auth) {
    throw new Error("браузер вернул неполную push-подписку");
  }
  await api("/api/v1/push/subscription", {
    method: "PUT",
    body: JSON.stringify({
      endpoint: serialized.endpoint,
      expirationTime: serialized.expirationTime ?? null,
      keys: serialized.keys
    })
  });
}

function ensureRegistration() {
  registrationPromise = registrationPromise ?? navigator.serviceWorker.register("/sw.js");
  return registrationPromise.then(() => navigator.serviceWorker.ready);
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIosFamily() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches === true ||
    navigator.standalone === true;
}

function setUi(text, canEnable, canDisable) {
  elements.pushStatus.textContent = text;
  elements.pushEnableButton.hidden = !canEnable;
  elements.pushDisableButton.hidden = !canDisable;
}

async function clearBadge() {
  try {
    if (typeof navigator.clearAppBadge === "function") await navigator.clearAppBadge();
  } catch {
    // Badging is an optional enhancement and must never break messaging.
  }
}

function base64UrlToUint8Array(value) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
