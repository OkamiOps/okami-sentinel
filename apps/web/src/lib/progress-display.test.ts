import assert from "node:assert/strict";
import test from "node:test";
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
