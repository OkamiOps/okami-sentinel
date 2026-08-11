import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT,
  normalizeResultArtifactInput,
} from "./result-artifact-contract.js";

test("generic JSON artifacts reject truncation and canonicalize a complete retry", () => {
  assert.equal(normalizeResultArtifactInput({
    path: "stage.json",
    content: '{"schemaVersion":1,"summary":"truncated',
  }, undefined), null);

  assert.deepEqual(normalizeResultArtifactInput({
    path: "stage.json",
    content: "```json\n{\"schemaVersion\":1,\"summary\":\"complete\"}\n```",
  }, undefined), {
    path: "stage.json",
    content: '{"schemaVersion":1,"summary":"complete"}',
  });
});

test("Portable stage artifacts validate the declared path and stage before I/O", () => {
  const wrongStage = JSON.stringify({
    schemaVersion: 1,
    stage: "discovery",
    summary: "wrong stage",
    observations: [],
  });
  assert.equal(normalizeResultArtifactInput({
    path: "01-inventory.json",
    content: wrongStage,
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);

  const valid = {
    schemaVersion: 1,
    stage: "inventory",
    summary: "complete",
    observations: [],
  };
  assert.deepEqual(normalizeResultArtifactInput({
    path: "01-inventory.json",
    content: JSON.stringify(valid),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), {
    path: "01-inventory.json",
    content: JSON.stringify(valid),
  });
});

test("Portable report never accepts an informational coverage statement as a vulnerability", () => {
  assert.equal(normalizeResultArtifactInput({
    path: "sentinel-findings.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "report",
      findings: [{
        id: "PCS-COVERAGE",
        candidateId: "candidate-coverage",
        title: "No security findings emitted",
        severity: "info",
        confidence: "high",
        category: "coverage",
        summary: "This is a coverage statement and not a reportable vulnerability.",
        rootCause: "No root cause exists because this is not a security finding.",
        impact: "No security impact exists because this is not a vulnerability.",
        remediation: "Do not emit coverage statements as security findings.",
        anchors: [{
          path: "src/index.ts",
          startLine: 1,
          endLine: 1,
          role: "evidence",
          explanation: "Coverage statements belong in the coverage section.",
        }],
      }],
      coverage: {
        inspected: ["src"],
        unexamined: [],
        candidates: [{
          candidateId: "candidate-coverage",
          disposition: "reported",
          reason: "not-vulnerable",
          evidence: [{ path: "src/index.ts", startLine: 1, endLine: 1, role: "evidence" }],
        }],
      },
    }),
  }, PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT), null);
});
