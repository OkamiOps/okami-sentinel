import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizePortableCodexSecurityWorkspace } from "./portable-codex-security-normalize.js";

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
  fs.writeFileSync(
    path.join(fixture.resultsDir, "sentinel-findings.json"),
    `${JSON.stringify({ schemaVersion: 1, findings }, null, 2)}\n`,
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

test("Portable Codex Security rejects each missing required finding field before writing findings", () => {
  for (const field of ["id", "title", "severity", "confidence", "category", "remediation"] as const) {
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
    {
      name: "range over 200 lines",
      prepare: (fixture) => {
        fs.writeFileSync(
          path.join(fixture.snapshotRoot, "src", "range.ts"),
          `${Array.from({ length: 201 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
        );
      },
      anchor: () => ({ path: "src/range.ts", startLine: 1, endLine: 201 }),
    },
  ];

  for (const invalid of cases) {
    const fixture = createFixture();
    try {
      invalid.prepare?.(fixture);
      writeHandoff(fixture, [validFinding(invalid.anchor(fixture))]);
      assert.throws(
        () => normalizePortableCodexSecurityWorkspace(fixture.resultsDir, fixture.outputDir),
        new RegExp(invalid.name, "i"),
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
