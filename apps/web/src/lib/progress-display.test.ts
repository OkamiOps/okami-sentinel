import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Telemetry } from "../pages/ScanDetailPage";
import { I18nProvider } from "../i18n";
import type { ScanRun } from "@csb/shared";
import type { ScanProgress } from "@csb/shared";
import * as format from "../format";

const mantisProgress: ScanProgress = {
  percent: 10,
  phase: "threat_model",
  phaseLabel: "Architecture",
  detail: "Command execution completed",
  unit: "stages",
  itemsCompleted: 0,
  itemsTotal: 9,
  currentItem: 1,
  indeterminate: true,
  activityState: "active",
  lastActivityAt: "2026-08-10T15:08:52.000Z",
};

test("stage-based progress uses the selected interface language without inventing percentages", () => {
  assert.equal(format.formatProgressMetric(mantisProgress, "en"), "STAGE 01/09");
  assert.equal(format.formatProgressMetric(mantisProgress, "pt-BR"), "ETAPA 01/09");
});

test("activity states use localized operator-facing labels", () => {
  assert.equal(format.formatActivityState("active", "en"), "ACTIVE");
  assert.equal(format.formatActivityState("quiet", "en"), "QUIET");
  assert.equal(format.formatActivityState("stale", "en"), "NO EVENTS");
  assert.equal(format.formatActivityState("stale", "pt-BR"), "SEM EVENTOS");
});

test("API progress labels follow the interface locale while provider telemetry is preserved", () => {
  const completed = { ...mantisProgress, phase: "reporting", phaseLabel: "Concluído", percent: 100 };
  for (const [locale, expected] of Object.entries({ "pt-BR": "Concluído", en: "Completed", es: "Completado", de: "Abgeschlossen", fr: "Terminé" })) {
    assert.equal(format.formatProgressLabel(completed, locale as import("../i18n").Locale), expected);
  }
  assert.equal(format.formatProgressLabel({ ...mantisProgress, phaseLabel: "Validação" }, "en"), "Validation");
  assert.equal(format.formatProgressLabel(mantisProgress, "fr"), "Architecture");
  assert.equal(format.formatProgressLabel({ ...mantisProgress, phaseLabel: "constructor" }, "en"), "constructor");
  assert.equal(format.formatProgressLabel(null, "en"), "—");
});


test("terminal scan telemetry closes activity while preserving the last phase and event", () => {
  for (const status of ["failed", "cancelled", "completed", "incomplete"] as const) {
    const scan = {
      status,
      progress: { ...mantisProgress, detail: "agent_turn_limit" },
      startedAt: "2026-08-10T15:00:00.000Z",
      completedAt: "2026-08-10T15:09:00.000Z",
      pid: null,
    } as ScanRun;
    const html = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(Telemetry, { scan, logs: ["agent_turn_limit"], logRef: createRef<HTMLPreElement>() }),
    ));
    assert.match(html, /stream encerrado/);
    assert.doesNotMatch(html, /ATIVO|Eventos do Codex chegando|live-dot/);
    assert.match(html, /Architecture/);
    assert.match(html, /agent_turn_limit/);
    assert.match(html, /10\/08\/2026/);
    assert.equal(format.formatScanProgress(scan).indeterminate, false);
    assert.equal(format.formatScanProgress(scan).value, 0);
  }
});

test("running scan telemetry still reports arriving events and indeterminate progress", () => {
  const scan = { status: "running", progress: mantisProgress } as ScanRun;
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(Telemetry, { scan, logs: [], logRef: createRef<HTMLPreElement>() }),
  ));
  assert.match(html, /ATIVO/);
  assert.equal(format.formatScanProgress(scan).indeterminate, true);
});
