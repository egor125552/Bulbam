import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describeElements, findControl, isVisible } from "./dom.js";

const markup = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

function locationFromStack() {
  const line = new Error().stack?.split("\n").find(row => /\/web\/js\/[^ )]+\.js:\d+:\d+/.test(row));
  const match = line?.match(/\/web\/(js\/[^ ):]+\.js):(\d+):(\d+)/);
  return match ? { file: "web/" + match[1], line: Number(match[2]) } : null;
}
function staticLocation(element) {
  if (!element.id) {
    // For static unnumbered buttons, match only if their text is unique
    // in the original HTML. Duplicates are deliberately left unresolved.
    if (element.tagName.toLowerCase() === "button") {
      const candidates = [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)];
      const normalize = text => text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      const wanted = normalize(element.textContent);
      const exact = candidates.filter(match => normalize(match[1]) === wanted);
      if (wanted && exact.length === 1) {
        return { file: "web/index.html", line: markup.slice(0, exact[0].index).split("\n").length };
      }
    }
    return null;
  }
  // Only claim an HTML line when the id occurs on an actual opening tag.
  const escaped = element.id.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("<[a-z][^>]*\\bid=[\\\"']" + escaped + "[\\\"'][^>]*>", "gi");
  const matches = [...markup.matchAll(regex)];
  if (matches.length !== 1) return null;
  return { file: "web/index.html", line: 1 + markup.slice(0, matches[0].index).split("\n").length - 1 };
}

export async function createBulbamAdapter() {
  const { window, document } = parseHTML(markup);
  const beforeGlobals = new Map();
  // This fixture exercises navigation handlers, not asynchronous DOM
  // decorations. Disable background mutation callbacks to keep each
  // virtual run deterministic and avoid callbacks after globals restore.
  class TrackedObserver {
    observe() {}
    disconnect() {}
  }
  const globals = {
    window, document, Node: window.Node, MutationObserver: TrackedObserver,
    CustomEvent: window.CustomEvent, Event: window.Event,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  };
  for (const [key, value] of Object.entries(globals)) {
    beforeGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const registered = new WeakMap();
  const created = new WeakMap();
  const originalListen = window.HTMLElement.prototype.addEventListener;
  const originalCreate = document.createElement.bind(document);
  window.HTMLElement.prototype.addEventListener = function (eventName, handler, options) {
    const where = locationFromStack();
    const previous = registered.get(this) ?? [];
    previous.push({ event: eventName, name: handler?.name || null, where });
    registered.set(this, previous);
    return originalListen.call(this, eventName, handler, options);
  };
  document.createElement = function (...args) {
    const el = originalCreate(...args);
    const where = locationFromStack();
    if (where) created.set(el, where);
    return el;
  };

  // linkedom select.value is read-only; browsers allow selecting an option.
  for (const select of document.querySelectorAll("select")) {
    Object.defineProperty(select, "value", {
      configurable: true,
      get() { return this.getAttribute("data-accesspilot-value") ?? this.querySelector("option")?.getAttribute("value") ?? ""; },
      set(value) { this.setAttribute("data-accesspilot-value", String(value)); }
    });
  }
  const dialog = document.getElementById("settings-dialog");
  // linkedom has real DOM events but no HTMLDialogElement display API.
  // This polyfill only models the open/close state, not native focus trapping.
  for (const element of document.querySelectorAll("dialog")) {
    Object.defineProperty(element, "open", { configurable: true, get() { return this.hasAttribute("open"); } });
    element.showModal = function () { this.setAttribute("open", ""); };
    element.close = function () {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      this.dispatchEvent(new window.Event("close"));
    };
  }
  document.getElementById("signed-out").hidden = true;
  document.getElementById("signed-in").hidden = false;
  // Synthetic owner state enables inspection of the invitations section,
  // without an account, real tokens, network or production data.
  document.getElementById("invite-card").hidden = false;
  const { setupSettingsScreens, resetSettingsScreen } = await import("../../web/js/settings-screens.js");
  const { setupInterface } = await import("../../web/js/ui.js");
  setupSettingsScreens();
  setupInterface();

  const locate = el => ({
    markup: staticLocation(el),
    generated: created.get(el) ?? null,
    handlers: (registered.get(el) ?? []).filter(h => h.where).map(h => ({
      event: h.event, function: h.name, ...h.where
    }))
  });
  const isNavigation = el => {
    if (el.disabled) return false;
    return ["settings-button", "settings-close", "settings-back"].includes(el.id)
      || el.hasAttribute("data-open-settings")
      || el.hasAttribute("data-settings-subpage");
  };
  const controls = () => describeElements(document, { locate, isNavigation });

  return {
    environment: "Бульбам: виртуальный DOM (linkedom) + настоящие функции экранов настроек",
    scope: "Главный экран, настройки, категории и вложенные страницы. Без сети, звонков, отправки и реального VoiceOver.",
    async reset() {
      dialog.close();
      resetSettingsScreen();
      await Promise.resolve();
    },
    async inspect() {
      const entries = controls();
      const opened = dialog.open;
      const heading = document.getElementById("settings-title").textContent.trim();
      const category = [...document.querySelectorAll("[data-settings-screen]")]
        .find(el => isVisible(el))?.getAttribute("data-settings-screen") ?? null;
      const name = !opened ? "Главный экран" : category ? "Настройки: " + heading : "Настройки: категории";
      const signature = JSON.stringify([opened, category, entries.map(el => [el.key, el.name, el.state])]);
      return { name, signature, elements: entries };
    },
    async activate(key) {
      const el = findControl(document, key);
      if (!el) return { ok: false, reason: "Элемент отсутствует или скрыт" };
      if (!isNavigation(el)) return { ok: false, reason: "Небезопасное или неподдерживаемое действие" };
      const handlers = registered.get(el) ?? [];
      if (!handlers.some(handler => handler.event === "click")) {
        return { ok: false, reason: "Обработчик нажатия в тестовой среде не подключён" };
      }
      try {
        el.click();
        await Promise.resolve();
        return { ok: true };
      } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
    },
    close() {
      window.HTMLElement.prototype.addEventListener = originalListen;
      document.createElement = originalCreate;
      for (const [key, descriptor] of beforeGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  };
}
