#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modes = ["signed-out", "signed-in", "composer"];
const scenarioRunner = fileURLToPath(new URL("./run-scenario.js", import.meta.url));
const scenarios = modes.map(mode => JSON.parse(execFileSync(process.execPath, [
  scenarioRunner, mode
], { encoding: "utf8", timeout: 15000, maxBuffer: 20 * 1024 * 1024 })));
const counters = ["screens", "elements", "inspectedOnly", "actions", "errors", "warnings"];
const summary = Object.fromEntries(counters.map(key => [
  key, scenarios.reduce((sum, scenario) => sum + scenario.summary[key], 0)
]));
summary.truncated = scenarios.some(scenario => scenario.summary.truncated);
summary.scenarios = scenarios.length;
const report = {
  formatVersion: 2,
  environment: "AccessPilot: виртуальные сценарии Бульбама, без сети и реального VoiceOver",
  summary,
  scenarios
};

const folder = resolve(process.cwd(), "accesspilot-report");
mkdirSync(folder, { recursive: true });
const jsonFile = resolve(folder, "Отчёт доступности Бульбама.json");
const textFile = resolve(folder, "Отчёт доступности Бульбама.txt");
writeFileSync(jsonFile, JSON.stringify(report, null, 2) + "\n");

const src = item => {
  const where = item?.source;
  const entries = [where?.markup, where?.generated, ...(where?.handlers ?? [])].filter(Boolean);
  return entries.map(e => e.file + ":" + e.line + (e.function ? " (" + e.function + ")" : "")).join("; ") || "точное место пока не определено";
};
const scenarioName = {
  "signed-out": "Вход, регистрация, восстановление аккаунта",
  "signed-in": "Главный экран, создание чата, все разделы настроек",
  "composer": "Ввод сообщения, создание чата и настройки (синтетический открытый чат)"
};
const lines = [
  "AccessPilot. Проверка доступности Бульбама",
  "Проверка: виртуальный DOM и настоящие обработчики безопасных действий, без реального VoiceOver.",
  "Сценариев: " + summary.scenarios,
  "Исследованных состояний по сценариям: " + summary.screens + " (включая повторения между сценариями)",
  "Проверок элементов по состояниям: " + summary.elements + " (включая повторения)",
  "Виртуальных нажатий: " + summary.actions,
  "Элементов только с проверкой названия и состояния: " + summary.inspectedOnly,
  "Ошибок доступности: " + summary.errors,
  "Предупреждений: " + summary.warnings,
  "Ограничение обхода достигнуто: " + (summary.truncated ? "да" : "нет")
];
for (const scenario of scenarios) {
  lines.push("", "СЦЕНАРИЙ: " + scenarioName[scenario.scenario], "",
    "Экраны: " + scenario.summary.screens + "; элементы: " + scenario.summary.elements +
    "; нажатия: " + scenario.summary.actions,
    "", "ОШИБКИ И ПРЕДУПРЕЖДЕНИЯ");
  lines.push(...(scenario.findings.length
    ? scenario.findings.map(f => [f.severity, f.code, f.screen, f.element, f.message || "", src(f)].join(" | "))
    : ["В проверенной части ошибок по действующим правилам не обнаружено."]));
  lines.push("", "ПРОЙДЕННЫЕ НАЖАТИЯ");
  lines.push(...scenario.actions.map(a => [
    a.screen, a.name, a.ok ? "выполнено" : "не удалось",
    a.changed ? "экран изменился" : "экран не изменился",
    a.result, a.focus ? "Фокус: " + (a.focus.id || a.focus.name || "без id") + (a.focus.visible ? " (видим)" : " (скрыт)") : "Фокус: не установлен",
    src(a), a.reason ?? ""
  ].join(" | ")));
  lines.push("", "ВСЕ ОБНАРУЖЕННЫЕ ЭЛЕМЕНТЫ");
  lines.push(...scenario.elements.map(e => [
    e.screen, e.key, e.predictedAnnouncement,
    e.action === "navigate" ? "действие можно проверять" : "действие не выполнялось",
    src(e)
  ].join(" | ")));
}
lines.push("",
  "ВАЖНО: предполагаемые объявления вычислены из HTML, это НЕ запись речи VoiceOver.",
  "Проверка открытого чата использует специально показанную форму. Она не доказывает работу переписки и звонков.",
  "Отправка, изменение данных, звонки и доступность настоящего браузерного фокуса НЕ проверяются.",
  "Отсутствие ошибок в виртуальных сценариях не означает полную доступность продукта.");
writeFileSync(textFile, lines.join("\n") + "\n");
console.log(lines.slice(0, 10).join("\n"));
console.log("\nОтчёты: " + textFile + " и " + jsonFile);
