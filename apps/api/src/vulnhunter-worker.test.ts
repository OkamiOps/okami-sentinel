import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REQUIRED_PHASES = [
  "phase1_recon.md",
  "phase2_hunt.md",
  "phase2_shared.md",
  "phase2_class_inj.md",
  "phase2_class_nav.md",
  "phase2_class_log.md",
  "phase2b_verify.md",
  "phase3_reproduce_test.md",
  "phase3c_fixes.md",
  "phase3d_sweep.md",
  "phase4_report.md",
];

test("VulnHunter worker completes a read-only run and preserves canonical evidence", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-worker-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const outputDir = path.join(fixtureRoot, "output");
  const skillRoot = path.join(fixtureRoot, "upstream", "vulnhunt");
  const fakeCodex = path.join(fixtureRoot, "fake-codex.mjs");
  const configPath = path.join(fixtureRoot, "vulnhunter-run.json");
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, "phases"), { recursive: true });
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(repositoryPath, "src", "app.ts"), "export const query = userInput;\n");
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "# VulnHunter fixture\n");
  for (const phase of REQUIRED_PHASES) {
    fs.writeFileSync(path.join(skillRoot, "phases", phase), `# ${phase}\n`);
  }
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const stateRoot = args[args.indexOf("--cd") + 1];
const resultsDir = path.join(stateRoot, "results");
const finalization = args.at(-1).includes("defensive static evidence finalizer");
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(stateRoot, finalization ? "finalization-invocation.json" : "invocation.json"), JSON.stringify(args));
if (!finalization) {
fs.writeFileSync(path.join(resultsDir, "phase1_output.md"), "recon");
fs.writeFileSync(path.join(resultsDir, "phase2b_output.md"), "verified");
fs.writeFileSync(path.join(resultsDir, "phase3_output.md"), "static proof only");
fs.writeFileSync(path.join(resultsDir, "phase3d_output.md"), "sweep");
} else {
fs.writeFileSync(path.join(resultsDir, "README.md"), "# Fixture report");
fs.writeFileSync(path.join(resultsDir, "sentinel-findings.json"), JSON.stringify({
  schemaVersion: 1,
  findings: [{
    id: "VULN-001",
    title: "Untrusted input reaches query",
    severity: "High",
    confidence: "high",
    cwe: ["CWE-89"],
    summary: "User input reaches a query sink.",
    rootCause: "The query is assembled without a binding.",
    entryPoint: "Public handler",
    dataFlow: "userInput → query",
    impact: "Unauthorized query manipulation.",
    remediation: "Use parameter binding.",
    validation: { summary: "Static trace survived falsification.", limitations: ["Not executed."] },
    evidence: [{ path: "src/app.ts", startLine: 1, endLine: 1, role: "sink", explanation: "Query sink." }]
  }]
}));
}
console.log(JSON.stringify({ type: "thread.started" }));
if (finalization) {
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } }));
} else {
  console.log(JSON.stringify({ type: "error", message: "upstream report session refused" }));
  console.log(JSON.stringify({ type: "turn.failed" }));
  process.exitCode = 1;
}
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(configPath, JSON.stringify({
    outputDir,
    repositoryPath,
    model: "gpt-5.6-sol",
    effort: "high",
    paths: ["src"],
    readOnly: true,
    source: {
      repositoryUrl: "https://github.com/capitalone/vulnhunter.git",
      ref: "8f9eadd772f66160df445b65730e2fbd6ea50d73",
      cacheDir: path.join(fixtureRoot, "cache"),
    },
  }));

  try {
    const result = spawnSync(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      [path.join(process.cwd(), "src", "scanners", "vulnhunter-worker.ts"), configPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_BIN: fakeCodex,
          VULNHUNTER_SKILL_DIR: skillRoot,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /upstream report session refused/);
    const runtime = JSON.parse(
      fs.readFileSync(path.join(outputDir, "vulnhunter-runtime.json"), "utf8"),
    ) as Record<string, unknown> & { usage: Record<string, number> };
    const normalized = JSON.parse(
      fs.readFileSync(path.join(outputDir, "findings.json"), "utf8"),
    ) as { findings: Array<{ codeEvidence: Array<{ code: string }> }> };
    const invocation = JSON.parse(
      fs.readFileSync(path.join(outputDir, "vulnhunter", "invocation.json"), "utf8"),
    ) as string[];
    const finalizationInvocation = JSON.parse(
      fs.readFileSync(path.join(outputDir, "vulnhunter", "finalization-invocation.json"), "utf8"),
    ) as string[];
    assert.equal(runtime.status, "completed");
    assert.equal(runtime.findings, 1);
    assert.equal(runtime.usage.inputTokens, 120);
    assert.equal(runtime.usage.cachedInputTokens, 40);
    assert.equal(runtime.usage.outputTokens, 30);
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.code, "export const query = userInput;");
    assert.equal(fs.readFileSync(path.join(repositoryPath, "src", "app.ts"), "utf8"), "export const query = userInput;\n");
    assert.ok(invocation.includes("multi_agent"));
    assert.ok(invocation.includes("browser_use"));
    assert.ok(invocation.includes("computer_use"));
    assert.ok(invocation.includes("workspace-write"));
    assert.ok(finalizationInvocation.includes("multi_agent"));
    assert.equal(finalizationInvocation[finalizationInvocation.indexOf("multi_agent") - 1], "--disable");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
