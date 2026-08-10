import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("VulnHunter worker completes a local static profile without loading the upstream skill", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-worker-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const outputDir = path.join(fixtureRoot, "output");
  const fakeCodex = path.join(fixtureRoot, "fake-codex.mjs");
  const configPath = path.join(fixtureRoot, "vulnhunter-run.json");
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(repositoryPath, "src", "app.ts"), "export const query = userInput;\n");
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const stateRoot = args[args.indexOf("--cd") + 1];
const prompt = args.at(-1);
if (/SKILL\\.md|phase[1-4]_|dispatch.*agent/i.test(prompt)) {
  console.log(JSON.stringify({ type: "error", message: "upstream instructions reached Codex" }));
  process.exit(9);
}
const resultsDir = path.join(stateRoot, "results");
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(stateRoot, "invocation.json"), JSON.stringify(args));
fs.writeFileSync(path.join(resultsDir, "reconnaissance.md"), "# Reconnaissance");
fs.writeFileSync(path.join(resultsDir, "trace-review.md"), "# Static traces");
fs.writeFileSync(path.join(resultsDir, "verification.md"), "# Verification");
fs.writeFileSync(path.join(resultsDir, "validation-notes.md"), "# Static limitations");
fs.writeFileSync(path.join(resultsDir, "coverage-sweep.md"), "# Coverage");
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
    validation: { summary: "Static trace survived falsification.", limitations: ["Static inspection only."] },
    evidence: [{ path: "src/app.ts", startLine: 1, endLine: 1, role: "sink", explanation: "Query sink." }]
  }]
}));
if (process.env.VULNHUNTER_TEST_UNSAFE === "1") {
  fs.writeFileSync(path.join(resultsDir, "validation.sh"), "echo unsafe");
  console.log(JSON.stringify({ type: "error", message: "fixture failed after writing artifacts" }));
  process.exit(7);
}
console.log(JSON.stringify({ type: "thread.started" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30 } }));
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
    profileVersion: "sentinel-static-v1",
    source: {
      repositoryUrl: "https://github.com/capitalone/vulnhunter.git",
      ref: "8f9eadd772f66160df445b65730e2fbd6ea50d73",
    },
  }));

  try {
    const result = spawnSync(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      [path.join(process.cwd(), "src", "scanners", "vulnhunter-worker.ts"), configPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_BIN: fakeCodex },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const runtime = JSON.parse(
      fs.readFileSync(path.join(outputDir, "vulnhunter-runtime.json"), "utf8"),
    ) as Record<string, unknown> & { usage: Record<string, number> };
    const normalized = JSON.parse(
      fs.readFileSync(path.join(outputDir, "findings.json"), "utf8"),
    ) as { findings: Array<{ codeEvidence: Array<{ code: string }> }> };
    const invocation = JSON.parse(
      fs.readFileSync(path.join(outputDir, "vulnhunter", "invocation.json"), "utf8"),
    ) as string[];
    assert.equal(runtime.status, "completed");
    assert.equal(runtime.findings, 1);
    assert.equal(runtime.usage.inputTokens, 120);
    assert.equal(runtime.usage.cachedInputTokens, 40);
    assert.equal(runtime.usage.outputTokens, 30);
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.code, "export const query = userInput;");
    assert.equal(fs.readFileSync(path.join(repositoryPath, "src", "app.ts"), "utf8"), "export const query = userInput;\n");
    assert.ok(invocation.includes("multi_agent"));
    assert.equal(invocation[invocation.indexOf("multi_agent") - 1], "--disable");
    assert.ok(invocation.includes("workspace-write"));
    assert.equal(fs.existsSync(path.join(outputDir, "vulnhunter-snapshot", "src", "app.ts")), true);

    const unsafeOutputDir = path.join(fixtureRoot, "unsafe-output");
    const unsafeConfigPath = path.join(fixtureRoot, "unsafe-vulnhunter-run.json");
    fs.mkdirSync(unsafeOutputDir);
    fs.writeFileSync(unsafeConfigPath, JSON.stringify({
      outputDir: unsafeOutputDir,
      repositoryPath,
      model: "gpt-5.6-sol",
      effort: "high",
      paths: ["src"],
      readOnly: true,
      profileVersion: "sentinel-static-v1",
      source: {
        repositoryUrl: "https://github.com/capitalone/vulnhunter.git",
        ref: "8f9eadd772f66160df445b65730e2fbd6ea50d73",
      },
    }));
    const unsafeResult = spawnSync(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      [path.join(process.cwd(), "src", "scanners", "vulnhunter-worker.ts"), unsafeConfigPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_BIN: fakeCodex, VULNHUNTER_TEST_UNSAFE: "1" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(unsafeResult.status, 1, unsafeResult.stderr || unsafeResult.stdout);
    const unsafeRuntime = JSON.parse(
      fs.readFileSync(path.join(unsafeOutputDir, "vulnhunter-runtime.json"), "utf8"),
    ) as { status: string; findings: number; error: string };
    assert.equal(unsafeRuntime.status, "failed");
    assert.equal(unsafeRuntime.findings, 0);
    assert.match(unsafeRuntime.error, /rejected operational artifact validation\.sh/);
    assert.equal(fs.existsSync(path.join(unsafeOutputDir, "findings.json")), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
