import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizePortableCodexSecurityWorkspace } from "./portable-codex-security-normalize.js";

const MAX_HANDOFF_BYTES = 1_048_576;
const MAX_FINDINGS = 128;
const MAX_ANCHORS_PER_FINDING = 20;
const MAX_TEXT_FIELD_BYTES = 16_384;
const MAX_SNIPPET_BYTES = 65_536;

interface Fixture {
  root: string;
  resultsDir: string;
  outputDir: string;
  snapshotRoot: string;
}

interface PortableAnchor {
  path: string;
  startLine: number;
  endLine?: number;
  role?: string;
  explanation?: string;
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-normalize-"));
  const resultsDir = path.join(root, "results");
  const outputDir = path.join(root, "output");
  const snapshotRoot = path.join(outputDir, "portable-codex-security-snapshot");
  fs.mkdirSync(path.join(snapshotRoot, "src"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(snapshotRoot, "src", "auth.ts"),
    [
      "export function loadUser(id: string) {",
      "  return db.users.findUnique({ where: { id } });",
      "}",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { root, resultsDir, outputDir, snapshotRoot };
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function validFinding(anchor: Partial<PortableAnchor> = {}): Record<string, unknown> {
  return {
    id: "PCS-001",
    candidateId: "candidate-001",
    title: "Authorization check is missing",
    severity: "high",
    confidence: "high",
    category: "Authorization",
    remediation: "Require an ownership check before querying the account.",
    summary: "The handler accepts an untrusted account identifier without an ownership predicate.",
    rootCause: "The query has no tenant condition.",
    impact: "A caller may read another account.",
    anchors: [{
      path: "src/auth.ts",
      startLine: 2,
      endLine: 2,
      role: "sink",
      explanation: "The account query uses the untrusted identifier.",
      ...anchor,
    }],
  };
}

function writeHandoff(fixture: Fixture, findings: Record<string, unknown>[]): void {
  const coverageCandidates = findings.flatMap((finding) => {
    const candidateId = typeof finding.candidateId === "string" ? finding.candidateId : null;
    const anchors = Array.isArray(finding.anchors) ? finding.anchors : [];
    if (candidateId === null || anchors.length === 0) return [];
    return [{
      candidateId,
      disposition: "reported",
      reason: "control-not-present",
      evidence: anchors.map((anchor) => ({
        path: (anchor as PortableAnchor).path,
        startLine: (anchor as PortableAnchor).startLine,
        endLine: (anchor as PortableAnchor).endLine ?? (anchor as PortableAnchor).startLine,
        role: (anchor as PortableAnchor).role ?? "evidence",
      })),
    }];
  });
  const dossier = {
    schemaVersion: 1,
    stageSummaries: [],
    candidates: coverageCandidates.map((coverage, index) => ({
      id: coverage.candidateId,
      category: "Authorization",
      anchors: coverage.evidence.slice(0, 1),
      index,
    })).map(({ index: _index, ...candidate }) => candidate),
    assessments: coverageCandidates.map((coverage) => ({
      candidateId: coverage.candidateId,
      stage: "validation",
      status: "confirmed",
      reason: coverage.reason,
      evidence: coverage.evidence.slice(0, 1),
    })),
    scope: { inspected: ["src"], unexamined: [] },
  };
  fs.writeFileSync(
    path.join(fixture.resultsDir, "sentinel-findings.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      findings,
      coverage: { inspected: ["src"], unexamined: [], candidates: coverageCandidates },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(fixture.resultsDir, "portable-codex-security-dossier.json"),
    `${JSON.stringify(dossier)}\n`,
    { mode: 0o600 },
  );
}

test("Portable Codex Security normalizes valid confined anchors with hydrated snippets and portable provenance", () => {
  const fixture = createFixture();
  try {
    writeHandoff(fixture, [validFinding()]);

    assert.equal(
      normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
      1,
    );

    const normalized = JSON.parse(
      fs.readFileSync(path.join(fixture.outputDir, "findings.json"), "utf8"),
    ) as {
      findings: Array<{
        findingId: string;
        locations: Array<{ path: string; startLine: number; endLine: number }>;
        codeEvidence: Array<{ code: string | null }>;
        fingerprints: { algorithm: string; primary: string };
        provenance: { source: string };
      }>;
    };
    const finding = normalized.findings[0]!;
    assert.equal(finding.findingId, "portable-codex-security-PCS-001");
    assert.deepEqual(finding.locations, [{
      path: "src/auth.ts",
      startLine: 2,
      endLine: 2,
      lines: "2",
      role: "primary",
    }]);
    assert.equal(
      finding.codeEvidence[0]?.code,
      "  return db.users.findUnique({ where: { id } });",
    );
    assert.equal(finding.fingerprints.algorithm, "sentinel-codex-security-portable/v1");
    assert.match(finding.fingerprints.primary, /^sentinel-codex-security-portable\/v1:sha256:/);
    assert.equal(finding.provenance.source, "sentinel-codex-security-portable/v1");
    assert.doesNotMatch(JSON.stringify(normalized), /openai|mantis|vulnhunter/i);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security normalizes a consolidated report with 116 findings", () => {
  const fixture = createFixture();
  try {
    const findings = Array.from({ length: 116 }, (_, index) => ({
      ...validFinding(),
      id: `PCS-${String(index + 1).padStart(3, "0")}`,
      candidateId: `candidate-${String(index + 1).padStart(3, "0")}`,
      title: `Authorization check is missing in flow ${index + 1}`,
    }));
    writeHandoff(fixture, findings);

    assert.equal(
      normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
      116,
    );
    const normalized = JSON.parse(
      fs.readFileSync(path.join(fixture.outputDir, "findings.json"), "utf8"),
    ) as { findings: unknown[] };
    assert.equal(normalized.findings.length, 116);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security redacts every public text field, evidence path, and source snippet", () => {
  const fixture = createFixture();
  const secret = "fake-secret-987654321";
  const cweSecret = "987654321";
  try {
    const secretRelativePath = `src/${secret}.ts`;
    fs.writeFileSync(
      path.join(fixture.snapshotRoot, secretRelativePath),
      `export const apiKey = "${secret}";\n`,
      { mode: 0o600 },
    );
    writeHandoff(fixture, [{
      ...validFinding({
        path: secretRelativePath,
        startLine: 1,
        endLine: 1,
        explanation: `Evidence contains ${secret}`,
      }),
      id: `PCS-${secret}`,
      candidateId: `candidate-${secret}`,
      title: `Title ${secret}`,
      category: `Category ${secret}`,
      remediation: `Remove ${secret}`,
      summary: `Summary ${secret}`,
      rootCause: `Root cause ${secret}`,
      impact: `Impact ${secret}`,
      severityRationale: `Rationale ${secret}`,
      cwe: [`CWE-${cweSecret}`],
    }]);

    normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir, {
      redactor: {
        redactText: (value: string) => value
          .replaceAll(secret, "[REDACTED]")
          .replaceAll(cweSecret, "[REDACTED]"),
      },
    });

    const serialized = fs.readFileSync(path.join(fixture.outputDir, "findings.json"), "utf8");
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(cweSecret), false);
    assert.match(serialized, /\[REDACTED\]/);
    const normalized = JSON.parse(serialized) as {
      findings: Array<{
        locations: Array<{ path: string }>;
        codeEvidence: Array<{ code: string; explanation: string }>;
        taxonomy: { cwe: string[] };
      }>;
    };
    assert.equal(normalized.findings[0]?.locations[0]?.path, "src/[REDACTED].ts");
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.code.includes(secret), false);
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.explanation.includes(secret), false);
    assert.deepEqual(normalized.findings[0]?.taxonomy.cwe, []);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security rejects each missing required finding field before writing findings", () => {
  for (const field of ["id", "candidateId", "title", "severity", "confidence", "category", "summary", "rootCause", "impact", "remediation"] as const) {
    const fixture = createFixture();
    try {
      const finding = validFinding();
      delete finding[field];
      writeHandoff(fixture, [finding]);
      assert.throws(
        () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
        new RegExp(`missing required ${field}`, "i"),
      );
      assert.equal(fs.existsSync(path.join(fixture.outputDir, "findings.json")), false);
    } finally {
      removeFixture(fixture.root);
    }
  }
});

test("Portable Codex Security rejects the whole handoff for every unsafe primary anchor", () => {
  const cases: Array<{
    name: string;
    prepare?: (fixture: Fixture) => void;
    anchor: (fixture: Fixture) => Partial<PortableAnchor>;
  }> = [
    {
      name: "traversal",
      anchor: () => ({ path: "../outside.ts" }),
    },
    {
      name: "nested traversal",
      anchor: () => ({ path: "src/../src/auth.ts" }),
    },
    {
      name: "absolute path",
      anchor: (fixture) => ({ path: path.join(fixture.snapshotRoot, "src", "auth.ts") }),
    },
    {
      name: "symlink",
      prepare: (fixture) => {
        fs.writeFileSync(path.join(fixture.root, "outside.ts"), "export const outside = true;\n");
        fs.symlinkSync(path.join(fixture.root, "outside.ts"), path.join(fixture.snapshotRoot, "src", "link.ts"));
      },
      anchor: () => ({ path: "src/link.ts" }),
    },
    {
      name: "missing file",
      anchor: () => ({ path: "src/missing.ts" }),
    },
    {
      name: "directory",
      anchor: () => ({ path: "src" }),
    },
    {
      name: "oversized file",
      prepare: (fixture) => {
        fs.writeFileSync(path.join(fixture.snapshotRoot, "src", "large.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
      },
      anchor: () => ({ path: "src/large.ts" }),
    },
    {
      name: "line zero",
      anchor: () => ({ startLine: 0, endLine: 0 }),
    },
    {
      name: "out-of-range line",
      anchor: () => ({ startLine: 99, endLine: 99 }),
    },
    {
      name: "reversed range",
      anchor: () => ({ startLine: 3, endLine: 2 }),
    },
  ];

  for (const invalid of cases) {
    const fixture = createFixture();
    try {
      invalid.prepare?.(fixture);
      writeHandoff(fixture, [validFinding(invalid.anchor(fixture))]);
      assert.throws(
        () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
        new RegExp(`${invalid.name}|coverage`, "i"),
      );
      assert.equal(
        fs.existsSync(path.join(fixture.outputDir, "findings.json")),
        false,
        invalid.name,
      );
    } finally {
      removeFixture(fixture.root);
    }
  }
});

test("Portable Codex Security preserves a wide location while bounding its hydrated excerpt", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.snapshotRoot, "src", "range.ts"),
      `${Array.from({ length: 1_070 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
    );
    writeHandoff(fixture, [validFinding({
      path: "src/range.ts",
      startLine: 1,
      endLine: 1_070,
    })]);

    assert.equal(
      normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
      1,
    );
    const normalized = JSON.parse(
      fs.readFileSync(path.join(fixture.outputDir, "findings.json"), "utf8"),
    ) as {
      findings: Array<{
        locations: Array<{ startLine: number; endLine: number }>;
        codeEvidence: Array<{ startLine: number; endLine: number; code: string }>;
      }>;
    };
    assert.deepEqual(normalized.findings[0]?.locations[0], {
      path: "src/range.ts",
      startLine: 1,
      endLine: 1_070,
      lines: "1-1070",
      role: "primary",
    });
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.startLine, 1);
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.endLine, 200);
    assert.match(normalized.findings[0]?.codeEvidence[0]?.code ?? "", /line 200$/);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security rejects a lexical snapshot root symlink before following it", () => {
  const fixture = createFixture();
  const outsideRoot = path.join(fixture.root, "outside-snapshot");
  try {
    fs.renameSync(fixture.snapshotRoot, outsideRoot);
    fs.symlinkSync(outsideRoot, fixture.snapshotRoot, "dir");
    writeHandoff(fixture, [validFinding()]);

    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
      /snapshot root symlink/i,
    );
    assert.equal(fs.existsSync(path.join(fixture.outputDir, "findings.json")), false);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security rejects a handoff above its byte limit before parsing", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.resultsDir, "sentinel-findings.json"),
      Buffer.alloc(MAX_HANDOFF_BYTES + 1, 0x20),
    );
    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
      /handoff byte limit/i,
    );
    assert.equal(fs.existsSync(path.join(fixture.outputDir, "findings.json")), false);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security bounds findings and anchors before normalization", () => {
  const findingFixture = createFixture();
  try {
    const findings = Array.from({ length: MAX_FINDINGS + 1 }, (_, index) => ({
      ...validFinding(),
      id: `PCS-${String(index + 1).padStart(3, "0")}`,
      candidateId: `candidate-${String(index + 1).padStart(3, "0")}`,
    }));
    writeHandoff(findingFixture, findings);
    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(
        findingFixture.resultsDir,
        findingFixture.outputDir,
      ),
      /finding limit/i,
    );
  } finally {
    removeFixture(findingFixture.root);
  }

  const anchorFixture = createFixture();
  try {
    const finding = validFinding();
    finding.anchors = Array.from({ length: MAX_ANCHORS_PER_FINDING + 1 }, () => ({
      path: "src/auth.ts",
      startLine: 2,
      endLine: 2,
    }));
    writeHandoff(anchorFixture, [finding]);
    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(
        anchorFixture.resultsDir,
        anchorFixture.outputDir,
      ),
      /anchor limit|coverage/i,
    );
  } finally {
    removeFixture(anchorFixture.root);
  }
});

test("Portable Codex Security bounds text fields and individual hydrated snippets", () => {
  const textFixture = createFixture();
  try {
    writeHandoff(textFixture, [{
      ...validFinding(),
      title: "t".repeat(MAX_TEXT_FIELD_BYTES + 1),
    }]);
    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(textFixture.resultsDir, textFixture.outputDir),
      /text field byte limit/i,
    );
  } finally {
    removeFixture(textFixture.root);
  }

  const snippetFixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(snippetFixture.snapshotRoot, "src", "large-line.ts"),
      "x".repeat(MAX_SNIPPET_BYTES + 1),
    );
    writeHandoff(snippetFixture, [validFinding({
      path: "src/large-line.ts",
      startLine: 1,
      endLine: 1,
    })]);
    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(
        snippetFixture.resultsDir,
        snippetFixture.outputDir,
      ),
      /snippet byte limit/i,
    );
  } finally {
    removeFixture(snippetFixture.root);
  }
});

test("Portable Codex Security rejects normalized output beyond its cumulative byte budget", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.snapshotRoot, "src", "wide.ts"),
      `export const wide = "${"x".repeat(60 * 1024)}";`,
    );
    const findings = Array.from({ length: 70 }, (_, index) => ({
      ...validFinding({ path: "src/wide.ts", startLine: 1, endLine: 1 }),
      id: `PCS-WIDE-${index + 1}`,
      candidateId: `candidate-wide-${index + 1}`,
    }));
    writeHandoff(fixture, findings);
    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
      /output byte budget/i,
    );
    assert.equal(fs.existsSync(path.join(fixture.outputDir, "findings.json")), false);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security debits output budget while hydrating instead of retaining every snippet", () => {
  const fixture = createFixture();
  const readCeiling = 80;
  let evidenceReads = 0;
  try {
    fs.writeFileSync(
      path.join(fixture.snapshotRoot, "src", "max-snippet.ts"),
      "x".repeat(MAX_SNIPPET_BYTES),
    );
    const findings = Array.from({ length: 100 }, (_, findingIndex) => ({
      ...validFinding(),
      id: `PCS-BUDGET-${findingIndex + 1}`,
      candidateId: `candidate-budget-${findingIndex + 1}`,
      anchors: Array.from({ length: MAX_ANCHORS_PER_FINDING }, () => ({
        path: "src/max-snippet.ts",
        startLine: 1,
        endLine: 1,
        role: "evidence",
        explanation: "This line provides repeated bounded evidence for normalization output.",
      })),
    }));
    writeHandoff(fixture, findings);

    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir, {
        fileSystem: {
          openSync: fs.openSync,
          fstatSync: fs.fstatSync,
          lstatSync: fs.lstatSync,
          closeSync: fs.closeSync,
          readSync: ((...args: unknown[]) => {
            evidenceReads += 1;
            if (evidenceReads > readCeiling) {
              throw new Error("read past incremental output budget");
            }
            return Reflect.apply(fs.readSync, fs, args) as number;
          }) as typeof fs.readSync,
        },
      }),
      /output byte budget/i,
    );
    assert.ok(evidenceReads <= readCeiling);
    assert.equal(fs.existsSync(path.join(fixture.outputDir, "findings.json")), false);
  } finally {
    removeFixture(fixture.root);
  }
});

test("Portable Codex Security rejects an evidence path swapped after its descriptor is opened", () => {
  const fixture = createFixture();
  const target = path.join(fixture.snapshotRoot, "src", "auth.ts");
  const originalTarget = path.join(fixture.snapshotRoot, "src", "auth-original.ts");
  let swapped = false;
  try {
    writeHandoff(fixture, [validFinding()]);

    assert.throws(
      () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir, {
        fileSystem: {
          openSync: fs.openSync,
          fstatSync: fs.fstatSync,
          lstatSync: fs.lstatSync,
          closeSync: fs.closeSync,
          readSync: ((...args: unknown[]) => {
            const bytesRead = Reflect.apply(fs.readSync, fs, args) as number;
            if (!swapped) {
              swapped = true;
              fs.renameSync(target, originalTarget);
              fs.writeFileSync(target, "export const swapped = true;\n", { mode: 0o600 });
            }
            return bytesRead;
          }) as typeof fs.readSync,
        },
      }),
      /evidence identity changed/i,
    );
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(fixture.outputDir, "findings.json")), false);
  } finally {
    removeFixture(fixture.root);
  }
});
