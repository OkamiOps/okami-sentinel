import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeVulnHunterHttpBundle,
  VULNHUNTER_HTTP_BUNDLE_NAME,
  VulnHunterHttpBundleError,
} from "./vulnhunter-http-bundle.js";

const MARKDOWN_ARTIFACTS = [
  "reconnaissance.md",
  "trace-review.md",
  "verification.md",
  "validation-notes.md",
  "coverage-sweep.md",
  "README.md",
] as const;

interface ReportFixture {
  schemaVersion: number;
  findings: unknown[];
}

function validReport(): ReportFixture {
  return {
    schemaVersion: 1,
    findings: [],
  };
}

function evidenceBackedReport(): ReportFixture {
  return {
    schemaVersion: 1,
    findings: [{
      id: "VULN-001",
      title: "Synthetic boundary test",
      severity: "high",
      confidence: "medium",
      cwe: ["CWE-20"],
      summary: "A synthetic test finding.",
      rootCause: "Unvalidated input reaches a sensitive operation.",
      entryPoint: "HTTP request field",
      dataFlow: "request -> validation -> sink",
      impact: "Unexpected behavior.",
      remediation: "Validate the input before the sink.",
      severityRationale: "A reachable sensitive operation is affected.",
      validation: {
        summary: "Static trace retained after defensive review.",
        limitations: ["Static inspection only."],
      },
      evidence: [{
        path: "src/app.ts",
        startLine: 4,
        endLine: 7,
        role: "sink",
        explanation: "The synthetic sink is reached here.",
      }],
    }],
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-http-bundle-"));
  const handoffRoot = path.join(root, "handoff");
  const resultsDir = path.join(root, "results");
  const snapshotRoot = path.join(root, "snapshot");
  fs.mkdirSync(handoffRoot, { mode: 0o700 });
  fs.mkdirSync(resultsDir, { mode: 0o700 });
  fs.mkdirSync(path.join(snapshotRoot, "src"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(snapshotRoot, "src", "app.ts"),
    Array.from({ length: 8 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return { root, handoffRoot, resultsDir, snapshotRoot };
}

function writeReport(handoffRoot: string, value: unknown): void {
  fs.writeFileSync(
    path.join(handoffRoot, VULNHUNTER_HTTP_BUNDLE_NAME),
    typeof value === "string" ? value : JSON.stringify(value),
    { encoding: "utf8", mode: 0o600 },
  );
}

test("VulnHunter HTTP materializes legacy artifacts from one canonical findings report", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    writeReport(handoffRoot, validReport());

    materializeVulnHunterHttpBundle(handoffRoot, resultsDir);

    assert.deepEqual(fs.readdirSync(resultsDir).sort(), [
      ...MARKDOWN_ARTIFACTS,
      "sentinel-findings.json",
    ].sort());
    for (const name of [...MARKDOWN_ARTIFACTS, "sentinel-findings.json"]) {
      assert.equal(fs.statSync(path.join(resultsDir, name)).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(resultsDir, "sentinel-findings.json"), "utf8")),
      { schemaVersion: 1, findings: [] },
    );
    assert.match(
      fs.readFileSync(path.join(resultsDir, "coverage-sweep.md"), "utf8"),
      /coverage (?:was )?not asserted/i,
    );
    assert.match(
      fs.readFileSync(path.join(resultsDir, "reconnaissance.md"), "utf8"),
      /no independent reconnaissance inventory/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP rejects a report without the canonical schema version", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    writeReport(handoffRoot, { findings: [] });
    assert.throws(
      () => materializeVulnHunterHttpBundle(handoffRoot, resultsDir),
      (error: unknown) => error instanceof VulnHunterHttpBundleError && error.code === "bundle_invalid",
    );
    assert.deepEqual(fs.readdirSync(resultsDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP projects one evidence-backed report without inventing another finding", () => {
  const { root, handoffRoot, resultsDir, snapshotRoot } = fixture();
  try {
    const report = evidenceBackedReport();
    writeReport(handoffRoot, report);

    materializeVulnHunterHttpBundle(handoffRoot, resultsDir, { snapshotRoot });

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(resultsDir, "sentinel-findings.json"), "utf8")),
      report,
    );
    assert.match(fs.readFileSync(path.join(resultsDir, "trace-review.md"), "utf8"), /src\/app\.ts:4-7/);
    assert.match(fs.readFileSync(path.join(resultsDir, "verification.md"), "utf8"), /Unvalidated input/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP leaves no partial final artifacts when staging fails mid-publish", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    writeReport(handoffRoot, validReport());
    let staged = 0;

    assert.throws(
      () => materializeVulnHunterHttpBundle(handoffRoot, resultsDir, {
        afterStageWrite() {
          staged += 1;
          if (staged === 3) throw new Error("synthetic staging failure");
        },
      }),
      (error: unknown) => error instanceof VulnHunterHttpBundleError && error.code === "bundle_invalid",
    );

    assert.equal(staged, 3);
    assert.deepEqual(fs.readdirSync(resultsDir), []);
    assert.deepEqual(fs.readdirSync(root).sort(), ["handoff", "results", "snapshot"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP rejects malformed or ambiguous reports before materialization", () => {
  const cases: Array<[string, unknown, (handoffRoot: string) => void]> = [
    ["malformed", "{not-json", () => undefined],
    ["wrong-version", { schemaVersion: 2, findings: [] }, () => undefined],
    ["unknown-root-field", { schemaVersion: 1, findings: [], provider: "ignored" }, () => undefined],
    ["findings-not-array", { schemaVersion: 1, findings: {} }, () => undefined],
    ["unexpected-file", validReport(), (handoffRoot) => {
      fs.writeFileSync(path.join(handoffRoot, "extra.txt"), "no", { mode: 0o600 });
    }],
  ];

  for (const [name, bundle, afterWrite] of cases) {
    const { root, handoffRoot, resultsDir } = fixture();
    try {
      writeReport(handoffRoot, bundle);
      afterWrite(handoffRoot);
      assert.throws(
        () => materializeVulnHunterHttpBundle(handoffRoot, resultsDir),
        (error: unknown) => error instanceof VulnHunterHttpBundleError && error.code === "bundle_invalid",
        name,
      );
      assert.deepEqual(fs.readdirSync(resultsDir), [], `${name} must not partially materialize`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("VulnHunter HTTP rejects a finding without the complete evidence-backed contract", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    writeReport(handoffRoot, {
      schemaVersion: 1,
      findings: [{ id: "VULN-001", title: "Missing evidence", severity: "high" }],
    });

    assert.throws(
      () => materializeVulnHunterHttpBundle(handoffRoot, resultsDir),
      (error: unknown) => error instanceof VulnHunterHttpBundleError && error.code === "bundle_invalid",
    );
    assert.deepEqual(fs.readdirSync(resultsDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
