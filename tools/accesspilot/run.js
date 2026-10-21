#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { explore } from "./engine.js";
import { createBulbamAdapter } from "./bulbam-adapter.js";

const adapter = await createBulbamAdapter();
let report;
try { report = await explore(adapter); }
finally { adapter.close(); }

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
const lines = [
  "AccessPilot. Проверка доступности Бульбама",
  "Проверка: виртуальное выполнение настоящих обработчиков экранов настроек, без реального VoiceOver.",
  "Проверенных экранов: " + report.summary.screens,
  "Исследованных элементов на экранах: " + report.summary.elements,
  "Виртуальных нажатий: " + report.summary.actions,
  "Элементов без выполнения действий: " + report.summary.inspectedOnly,
  "Ошибок доступности: " + report.summary.errors,
  "Предупреждений: " + report.summary.warnings,
  "Ограничение обхода достигнуто: " + (report.summary.truncated ? "да" : "нет"),
  "",
  "ОШИБКИ И ПРЕДУПРЕЖДЕНИЯ",
  ...report.findings.map(f => [f.severity, f.code, f.screen, f.element, f.message || "", src(f)].join(" | ")),
  "",
  "ПРОЙДЕННЫЕ НАЖАТИЯ",
  ...report.actions.map(a => [a.screen, a.name, a.ok ? "выполнено" : "не удалось",
    a.changed ? "экран изменился" : "экран не изменился",
    a.result, src(a), a.reason ?? ""].join(" | ")),
  "",
  "ВСЕ ОБНАРУЖЕННЫЕ ЭЛЕМЕНТЫ",
  ...report.elements.map(e => [e.screen, e.key, e.predictedAnnouncement,
    e.action === "navigate" ? "действие проверяется" : "только проверка доступности", src(e)].join(" | ")),
  "",
  "Важно: предполагаемые объявления получены из HTML-атрибутов и НЕ являются записью речи VoiceOver.",
  "Кнопки изменения данных и внешние сетевые действия специально не нажимаются.",
  "Динамические экраны, для которых не подключены обработчики, не считаются протестированными."
];
writeFileSync(textFile, lines.join("\n") + "\n");
console.log(lines.slice(0, 12).join("\n"));
console.log("\nОтчёты: " + textFile + " и " + jsonFile);
