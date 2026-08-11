import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFindingsFile, recoverFindingsJsonFromMarkdown } from "./ingest.js";

function writeSession(
  sessionsRoot: string,
  name: string,
  meta: { id: string; parentId: string | null; cwd: string },
  findings?: Array<Record<string, unknown>>,
): void {
  const dayDir = path.join(sessionsRoot, "2026", "08", "08");
  fs.mkdirSync(dayDir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [{
    type: "session_meta",
    timestamp: "2026-08-08T07:20:00.000Z",
    payload: {
      id: meta.id,
      parent_thread_id: meta.parentId,
      cwd: meta.cwd,
    },
  }];
  if (findings) {
    rows.push({
      type: "response_item",
      timestamp: "2026-08-08T07:30:00.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ findings }) }],
      },
    });
  }
  fs.writeFileSync(
    path.join(dayDir, `${name}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

test("recovers partial findings from child Codex sessions when the root never consolidated", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-session-recovery-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  fs.mkdirSync(scanDir);

  try {
    writeSession(sessionsRoot, "root", { id: "root", parentId: null, cwd: scanDir });
    writeSession(
      sessionsRoot,
      "worker-a",
      { id: "worker-a", parentId: "root", cwd: scanDir },
      [{
        title: "JWT forgery",
        severity: "critical",
        cwe: "CWE-347",
        locations: ["lib/auth.ts:42"],
        concrete_impact: "Account takeover",
      }],
    );
    writeSession(
      sessionsRoot,
      "worker-b",
      { id: "worker-b", parentId: "root", cwd: scanDir },
      [{
        title: "Stored XSS",
        severity: "high",
        cwe: "CWE-79",
        locations: [{ file: "routes/profile.ts", lines: "10-18" }],
        impact: "Same-origin script execution",
      }],
    );

    assert.equal(recoverFindingsJsonFromMarkdown(scanDir, sessionsRoot), 2);
    const recovered = JSON.parse(
      fs.readFileSync(path.join(scanDir, "findings.json"), "utf8"),
    ) as {
      recovery: { source: string; consolidated: boolean; sessionCount: number };
      findings: Array<Record<string, unknown>>;
    };
    assert.deepEqual(recovered.recovery, {
      source: "codex-session-workers",
      consolidated: false,
      sessionCount: 2,
      note: "Recovered from worker results after the root session stopped before consolidation; semantic overlap may remain.",
    });
    assert.equal(recovered.findings[0]?.title, "JWT forgery");
    assert.deepEqual(recovered.findings[0]?.taxonomy, {
      category: "Recovered worker finding",
      cwe: ["CWE-347"],
    });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("prefers a consolidated root result over worker output", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-session-root-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  fs.mkdirSync(scanDir);

  try {
    writeSession(
      sessionsRoot,
      "root",
      { id: "root", parentId: null, cwd: scanDir },
      [{ title: "Consolidated result", severity: "medium" }],
    );
    writeSession(
      sessionsRoot,
      "worker",
      { id: "worker", parentId: "root", cwd: scanDir },
      [{ title: "Worker draft", severity: "high" }],
    );

    assert.equal(recoverFindingsJsonFromMarkdown(scanDir, sessionsRoot), 1);
    const recovered = JSON.parse(
      fs.readFileSync(path.join(scanDir, "findings.json"), "utf8"),
    ) as { recovery: { consolidated: boolean }; findings: Array<{ title: string }> };
    assert.equal(recovered.recovery.consolidated, true);
    assert.equal(recovered.findings[0]?.title, "Consolidated result");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("upgrades recovered session findings with worker evidence and source-to-sink details", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-session-evidence-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  fs.mkdirSync(scanDir);

  try {
    fs.writeFileSync(
      path.join(scanDir, "findings.json"),
      JSON.stringify({
        documentType: "codex-security.findings",
        schemaVersion: "recovered-session-2",
        recovered: true,
        findings: [{
          findingId: "recovered-session-worker-2",
          title: "SQL injection in search endpoint",
          locations: [],
          codeEvidence: [],
        }],
      }),
      "utf8",
    );
    writeSession(sessionsRoot, "root", { id: "root", parentId: null, cwd: scanDir });
    writeSession(
      sessionsRoot,
      "worker",
      { id: "worker", parentId: "root", cwd: scanDir },
      [{
        title: "SQL injection in search endpoint",
        severity: "high",
        cwe: "CWE-89",
        source_to_sink: "req.query.q -> raw query in routes/search.ts",
        impact: "Data exfiltration through destructive query execution",
        evidence: [{
          file: "routes/search.ts:23",
          notes: "The query argument is inserted directly into SQL text.",
        }],
        counterevidence: "No prepared-statement binding was observed.",
        remediation: "Use parameterized SQL.",
      }, {
        title: "IDOR in basket item update",
        severity: "high",
        location: ["routes/basketItems.ts:42", "models/basketItem.ts:17-21"],
        evidence: "The request-controlled item id reaches an ownership-blind update.",
      }, {
        title: "Unprotected diagnostics surface",
        severity: "medium",
        category: "Access control",
        request_surface: "GET /api/diagnostics",
        files: ["routes/diagnostics.ts:11", "server.ts:204"],
        evidence: "The route is registered without an authorization middleware.",
      }],
    );

    const [finding, locationFinding, filesFinding] = readFindingsFile(
      scanDir,
      sessionsRoot,
    );
    assert.equal(finding?.primaryPath, "routes/search.ts");
    assert.deepEqual(finding?.locations, [{
      path: "routes/search.ts",
      startLine: 23,
      endLine: 23,
      lines: "23",
      role: "primary",
    }]);
    assert.deepEqual(finding?.codeEvidence, [{
      id: "evidence-1",
      label: "Recovered evidence at routes/search.ts:23",
      path: "routes/search.ts",
      startLine: 23,
      endLine: 23,
      lines: "23",
      role: "evidence",
      code: null,
      language: "typescript",
      explanation: "The query argument is inserted directly into SQL text.",
    }]);
    assert.deepEqual(finding?.attackPath, {
      summary: "req.query.q -> raw query in routes/search.ts",
      evidenceRefs: ["evidence-1"],
      dataflow: {
        summary: "req.query.q -> raw query in routes/search.ts",
        outcome: "Data exfiltration through destructive query execution",
        evidenceRefs: ["evidence-1"],
      },
    });
    assert.equal(locationFinding?.primaryPath, "routes/basketItems.ts");
    assert.deepEqual(
      (locationFinding?.codeEvidence as Array<Record<string, unknown>>).map(
        (item) => ({
          path: item.path,
          lines: item.lines,
          code: item.code,
          explanation: item.explanation,
        }),
      ),
      [{
        path: "routes/basketItems.ts",
        lines: "42",
        code: null,
        explanation: "The request-controlled item id reaches an ownership-blind update.",
      }, {
        path: "models/basketItem.ts",
        lines: "17-21",
        code: null,
        explanation: "The request-controlled item id reaches an ownership-blind update.",
      }],
    );
    assert.equal(filesFinding?.primaryPath, "routes/diagnostics.ts");
    assert.equal(filesFinding?.category, "Access control");
    assert.deepEqual(
      (filesFinding?.codeEvidence as Array<Record<string, unknown>>).map(
        (item) => item.path,
      ),
      ["routes/diagnostics.ts", "server.ts"],
    );
    assert.equal(
      (filesFinding?.attackPath as { summary?: unknown }).summary,
      "GET /api/diagnostics",
    );

    const upgraded = JSON.parse(
      fs.readFileSync(path.join(scanDir, "findings.json"), "utf8"),
    ) as { schemaVersion: string };
    assert.equal(upgraded.schemaVersion, "recovered-session-3");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
