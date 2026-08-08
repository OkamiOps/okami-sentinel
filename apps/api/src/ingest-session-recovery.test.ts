import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverFindingsJsonFromMarkdown } from "./ingest.js";

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
