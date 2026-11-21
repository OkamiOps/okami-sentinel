import assert from "node:assert/strict";
import test from "node:test";
import type { ScanBudgetPartial, ScanRun } from "@csb/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScanBudgetPartialBanner } from "../components/scans/ScanBudgetPartialBanner.js";
import { I18nProvider, translate, type Locale } from "../i18n.js";
import { budgetResumeCommand, isBudgetPartial } from "./scan-budget.js";
import { scanBudgetMessages } from "../i18n/scan-budget.js";

const summary: ScanBudgetPartial = {
  stopReason: "budget", spentUsd: 1.1, maxCostUsd: 1,
  completed: [], interrupted: { stage: "inventory", page: "inventory", artifactPath: null }, pending: [],
};

test("budget banner is limited to incomplete runs with the budget reason", () => {
  assert.equal(isBudgetPartial({ status: "incomplete", statusReason: "budget_exhausted" }), true);
  assert.equal(isBudgetPartial({ status: "incomplete" }), false);
  for (const status of ["queued", "running", "completed", "failed", "cancelled"] as const) {
    assert.equal(isBudgetPartial({ status, statusReason: "budget_exhausted" }), false);
  }
});

test("resume hint includes scan ID and a cap higher than both spend and previous cap", () => {
  assert.equal(budgetResumeCommand("scan-123", summary), "pnpm exec tsx src/scanners/resume-portable-scan.ts 'scan-123' --max-cost-usd 3");
  assert.match(budgetResumeCommand("scan-123", { ...summary, spentUsd: 0, maxCostUsd: 5 }), /--max-cost-usd 10$/);
  assert.match(budgetResumeCommand("scan-123", { ...summary, spentUsd: 0, maxCostUsd: 0.001 }), /--max-cost-usd 1$/);
  assert.match(budgetResumeCommand("scan'quoted", summary), /'scan'\\''quoted'/);
});

test("Portuguese budget copy explains the cap limitation and explicit acknowledgement", () => {
  const copy = scanBudgetMessages["pt-BR"];
  assert.equal(copy.budgetPartial, "Parcial por orçamento");
  assert.match(copy.capWarning, /\{engine\}.*consumo do plano.*Codex Security.*explicitamente.*Sem teto em USD/);
  assert.match(copy.budgetResume, /gasto anterior.*novo teto.*apps\/api/);
});

test("Codex cap disclosures explain reservations, reduced or skipped calls, estimated usage, and resumable partial stages in every locale", () => {
  const expected: Record<Locale, string[]> = {
    "pt-BR": ["reserva orçamento antes do envio", "saída é reduzida", "chamada é pulada", "estimado", "uso reportado pelo provedor", "parcial por orçamento", "etapas salvas", "retomar"],
    en: ["reserves budget before sending", "output is reduced", "call is skipped", "estimated", "provider-reported usage", "budget-partial", "saved stages", "resumed"],
    es: ["reserva presupuesto antes del envío", "reduce la salida", "omite la llamada", "estima", "uso reportado por el proveedor", "parcial por presupuesto", "etapas guardadas", "reanudar"],
    de: ["vor dem Senden Budget", "Ausgabe gekürzt", "Aufruf übersprungen", "Providernutzung geschätzt", "fortsetzbares Budget-Teilergebnis", "gespeicherten Stufen"],
    fr: ["réserve du budget avant l’envoi", "sortie est réduite", "appel ignoré", "estimé", "usage déclaré par le fournisseur", "partiel", "étapes sauvegardées", "reprise possible"],
  };
  for (const locale of Object.keys(expected) as Locale[]) {
    const copy = translate(locale, "newScan.portableCostCeilingDisclosure");
    for (const phrase of expected[locale]) assert.ok(copy.includes(phrase), `${locale}: ${phrase}`);
    const nativeCopy = translate(locale, "newScan.costCeilingDisclosure");
    assert.notEqual(nativeCopy, copy);
    assert.doesNotMatch(nativeCopy, /reserva|reserves|reserviert|réserve|Budget-Teilergebnis/);
  }
});

function renderBanner(scan: Pick<ScanRun, "id" | "status" | "statusReason" | "budgetPartial">): string {
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ScanBudgetPartialBanner, { scan: scan as ScanRun })));
}

test("budget banner renders spent/cap, saved paths, interrupted and pending work, and resume command", () => {
  const html = renderBanner({ id: "scan-123", status: "incomplete", statusReason: "budget_exhausted", budgetPartial: {
    ...summary,
    completed: [{ stage: "inventory", page: "inventory", artifactPath: "/saved/01-inventory.json" }],
    interrupted: { stage: "discovery", page: "page-2", artifactPath: "/planned/page-2.json" },
    pending: [{ stage: "discovery", page: "page-3", artifactPath: "/planned/page-3.json" }, { stage: "report", page: null, artifactPath: null }],
  } });
  for (const expected of ["Parcial por orçamento", "Gasto:", "teto:", "1,10", "1,00", "Etapas/páginas concluídas", "/saved/01-inventory.json", "Etapa/página interrompida", "discovery / page-2", "Etapas/páginas pendentes", "discovery / page-3", "report / páginas a definir", "scan-123", "--max-cost-usd 3"]) {
    assert.ok(html.includes(expected), expected);
  }
});

test("budget banner handles empty completed work and missing summary without inventing results", () => {
  const scan = { id: "scan-empty", status: "incomplete" as const, statusReason: "budget_exhausted" as const };
  assert.match(renderBanner({ ...scan, budgetPartial: summary }), /Nenhuma/);
  assert.match(renderBanner(scan), /O resumo do orçamento não está disponível/);
  assert.doesNotMatch(renderBanner(scan), /resume-portable-scan/);
  assert.equal(renderBanner({ ...scan, statusReason: undefined, budgetPartial: summary }), "");
});
