import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFindingsFile } from "./ingest.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "attack-path",
);

test("ingestion exposes the normalized attack path model", () => {
  const findings = readFindingsFile(fixtureDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.attackPathModel?.status, "validated");
  assert.deepEqual(
    findings[0]?.attackPathModel?.lanes[0]?.nodes.map((node) => node.id),
    ["source-1", "sink-2", "primary:outcome"],
  );
});
