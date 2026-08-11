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
