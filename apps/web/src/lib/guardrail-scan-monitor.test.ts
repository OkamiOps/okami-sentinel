import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { GateRun, ScanRun } from "@csb/shared";

import { GuardrailScanMonitor, ScanResultActions } from "../components/guardrails/GuardrailScanMonitor.js";
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

test("portfolio detail isolates its queue and counters to the selected project", () => {
  const selected = gate(18);
  const other = {
    ...gate(9),
    id: "gate-other-project",
    repositoryKey: "github:2",
    baseRef: "release",
    headRef: "feature/other-project",
  };
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(PortfolioPipeline, {
      repositories: [
        { repositoryKey: "github:1", source: "github" },
        { repositoryKey: "github:2", source: "github" },
      ] as never,
      gates: [selected, other],
      selectedGateId: selected.id,
      selectedArtifact: null,
      onSelect: () => undefined,
    }),
  ));

  assert.match(html, />1<\/dd>/);
  assert.doesNotMatch(html, /feature\/other-project/);
  assert.doesNotMatch(html, /gate-other-project/);
});

test("portfolio queue uses the repository name and a human scan identity instead of the GitHub database key", () => {
  const completed = {
    ...gate(18),
    id: "gate-human-name",
    scanId: "scan-completed-123",
    status: "completed" as const,
    outcome: "bootstrap" as const,
    baseRef: "main",
    headRef: "main",
    pullRequestNumber: null,
    completedAt: "2026-08-13T00:07:13.000Z",
  };
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(PortfolioPipeline, {
      repositories: [{
        repositoryKey: "github:1",
        displayName: "aitherion-labs/mvp-luna-classic",
        source: "github",
      }] as never,
      gates: [completed],
      scans: [{
        id: "scan-completed-123",
        engine: "codex-security",
        model: "gpt-5.3-codex-spark",
        severity: { critical: 0, high: 2, medium: 0, low: 0, info: 0, total: 2 },
      }] as never,
      selectedGateId: completed.id,
      selectedArtifact: null,
      onSelect: () => undefined,
    }),
  ));

  assert.match(html, /mvp-luna-classic\/main/);
  assert.match(html, /Branch completa · main/);
  assert.match(html, /SCAN scan-com/);
  assert.match(html, /Codex Security · gpt-5.3-codex-spark/);
  assert.match(html, /7m 13s/);
  assert.doesNotMatch(html, />github:1</);
});

test("a failed gate marks the scan stage as failed rather than completed", () => {
  const failed = {
    ...gate(18),
    scanId: "scan-failed",
    status: "completed" as const,
    outcome: "error" as const,
    completedAt: "2026-08-13T00:00:08.000Z",
  };
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(PortfolioPipeline, {
      repositories: [{ repositoryKey: "github:1", displayName: "owner/repo", source: "github" }] as never,
      gates: [failed],
      selectedGateId: failed.id,
      selectedArtifact: null,
      onSelect: () => undefined,
    }),
  ));

  assert.match(html, /text-destructive[^>]*">Falhou/);
});

test("a completed guardrail scan exposes its findings as the primary result action", () => {
  const scan = {
    id: "scan-findings",
    status: "completed",
    severity: { critical: 1, high: 5, medium: 1, low: 0, info: 0, total: 7 },
  } as ScanRun;
  const html = renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(I18nProvider, null, createElement(ScanResultActions, { scan })),
  ));

  assert.match(html, /Ver 7 findings/);
  assert.match(html, /href="\/scans\/scan-findings"/);
});
