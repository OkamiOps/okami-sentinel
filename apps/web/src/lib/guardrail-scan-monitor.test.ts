import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GateRun } from "@csb/shared";

import { GuardrailScanMonitor } from "../components/guardrails/GuardrailScanMonitor.js";
import { PortfolioPipeline } from "../components/guardrails/PortfolioPipeline.js";
import { I18nProvider } from "../i18n.js";

function gate(costCeilingUsd: number): GateRun {
  return {
    id: "gate-monitor",
    repositoryKey: "github:1",
    repositoryPath: null,
    source: "github",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "feature/monitor",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    policySha: "a".repeat(40),
    pullRequestNumber: 12,
    workflowRunId: null,
    materializationState: "materializing",
    scanLineageHash: null,
    artifactSchemaVersion: 2,
    scanId: null,
    status: "resolving",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: "waiting",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: null,
    costCeilingUsd,
    estimatedUsd: 0,
  };
}

test("guardrail monitor shows the frozen ceiling while materializing without claiming zero cost", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(GuardrailScanMonitor, { gate: gate(18) }),
  ));

  assert.match(html, /Materializando o alvo/);
  assert.match(html, /Teto de custo/);
  assert.match(html, /18,00/);
});

test("legacy gates do not present a zero ceiling as a real estimate", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(GuardrailScanMonitor, { gate: gate(0) }),
  ));

  assert.doesNotMatch(html, /USD[^<]*0,00/);
});

test("portfolio header shows a frozen ceiling separately and never invents a zero estimate", () => {
  const ceilingGate = gate(18);
  const ceilingHtml = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(PortfolioPipeline, {
      repositories: [],
      gates: [ceilingGate],
      selectedGateId: ceilingGate.id,
      selectedArtifact: null,
      onSelect: () => undefined,
    }),
  ));
  assert.match(ceilingHtml, /Teto de custo/);
  assert.match(ceilingHtml, /18,00/);

  const legacyGate = gate(0);
  const legacyHtml = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(PortfolioPipeline, {
      repositories: [],
      gates: [legacyGate],
      selectedGateId: legacyGate.id,
      selectedArtifact: null,
      onSelect: () => undefined,
    }),
  ));
  assert.doesNotMatch(legacyHtml, /USD[^<]*0,00/);
});
