import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readAiFindingsFile, readScanFindings, toFindingSummaries } from "../ingest.js";
import { normalizeOpengrep, readOpengrepFindings, readOpengrepStatus, runOpengrep } from "./opengrep.js";
import { opengrepConfiguration } from "../config.js";
import { localMantisWorkerEnvironment, portableCodexSecurityWorkerEnvironment } from "../scanners/launch.js";

const binary = fileURLToPath(new URL("./fixtures/fake-opengrep.mjs", import.meta.url));

test("configuration defaults offline and both restricted worker environments forward SAST settings", (t) => {
  const keys = ["SENTINEL_OPENGREP_ENABLED", "SENTINEL_OPENGREP_BIN", "SENTINEL_OPENGREP_RULES", "SENTINEL_OPENGREP_TIMEOUT_MS"];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  for (const key of keys) delete process.env[key];
  const defaults = opengrepConfiguration();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.binary, "opengrep");
  assert.equal(defaults.timeoutMs, 300_000);
  assert.ok(defaults.rules.every(rule => fs.existsSync(rule)));
  process.env.SENTINEL_OPENGREP_ENABLED = "false";
  process.env.SENTINEL_OPENGREP_BIN = binary;
  process.env.SENTINEL_OPENGREP_RULES = ["/rules/one", "/rules/two"].join(path.delimiter);
  process.env.SENTINEL_OPENGREP_TIMEOUT_MS = "42";
  assert.deepEqual(opengrepConfiguration(), { enabled: false, binary, rules: ["/rules/one", "/rules/two"], timeoutMs: 42 });
  for (const createEnvironment of [localMantisWorkerEnvironment, portableCodexSecurityWorkerEnvironment]) {
    const env = createEnvironment({ ...process.env, OPENAI_API_KEY: "not-for-sast" });
    for (const key of keys) assert.equal(env[key], process.env[key]);
    assert.equal(env.OPENAI_API_KEY, undefined);
  }
});

test("normalization preserves relative locations, stable identities, CWE, severity and origin", () => {
  const result = {
    check_id: "rule", path: "/snapshot/src/app.ts", start: { line: 2, col: 3 }, end: { line: 2, col: 9 },
    extra: { severity: "ERROR", message: "Review", lines: "eval(x)", metadata: { cwe: ["CWE-95"] } },
  };
  const normalize = (value = result) => normalizeOpengrep({ results: [value], errors: [] }, "/snapshot")[0];
  const finding = normalize();
  assert.equal(finding.primaryPath, "src/app.ts");
  assert.equal(finding.ruleId, "rule");
  assert.equal(finding.severity, "high");
  assert.deepEqual(finding.origin, { kind: "sast", tool: "opengrep" });
  assert.deepEqual(finding.cwe, ["CWE-95"]);
  assert.deepEqual(finding.locations, [{ path: "src/app.ts", startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 }]);
  assert.equal(normalize({ ...result, path: "src/app.ts" }).findingId, finding.findingId);
  assert.match(finding.findingId, /^opengrep:[a-f0-9]{64}$/);
  for (const [severity, expected] of [["WARNING", "medium"], ["INFO", "low"], ["CRITICAL", "critical"], ["HIGH", "high"], ["MEDIUM", "medium"], ["LOW", "low"]]) {
    assert.equal(normalize({ ...result, extra: { ...result.extra, severity } }).severity, expected);
  }
  assert.equal(normalize({ ...result, extra: { ...result.extra, metadata: { cwe: [], severity: "critical" } } } as typeof result).severity, "critical");
  assert.deepEqual(normalizeOpengrep({ results: [], errors: [] }, "/snapshot"), []);
  for (const value of [{}, { results: null }, { results: "invalid" }]) {
    assert.throws(() => normalizeOpengrep(value, "/snapshot"), /invalid_result/);
  }
  assert.equal(normalize({ ...result, path: "../escape.ts" }), undefined);
  assert.deepEqual(normalizeOpengrep({ results: [{}], errors: [] }, "/snapshot"), []);
  assert.deepEqual(normalizeOpengrep({ results: [], errors: ["failure"] }, "/snapshot"), []);
});

for (const mode of ["completed", "empty", "bad-json", "nonzero", "missing", "disabled", "timeout", "remote-rules"]) {
  test(`OpenGrep durably records ${mode} without throwing`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-sast-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const snapshot = path.join(root, "snapshot");
    fs.mkdirSync(snapshot);
    const rules = path.join(root, "rules.json");
    const calls = path.join(root, "calls");
    const pidFile = path.join(root, "child-pid");
    fs.writeFileSync(rules, JSON.stringify({ mode, calls, pidFile }));
    const config = { enabled: mode !== "disabled", binary: mode === "missing" ? path.join(root, "absent") : binary,
      rules: mode === "remote-rules" ? ["auto"] : [rules], timeoutMs: mode === "timeout" ? 800 : 5000 };
    await runOpengrep(snapshot, root, config);
    const status = readOpengrepStatus(root)!;
    assert.equal(status.status, ["completed", "empty"].includes(mode) ? "completed" :
      ["disabled", "missing"].includes(mode) ? "skipped" : mode === "timeout" ? "timeout" : "failed");
    assert.equal(status.count, mode === "completed" ? 1 : 0);
    assert.ok(status.startedAt && status.finishedAt && status.durationMs >= 0);
    assert.ok(!JSON.stringify(status).includes("secret must not"));
    assert.deepEqual(fs.readdirSync(path.join(root, "sast")).filter(name => name.includes(".tmp")), []);
    if (mode === "completed" || mode === "empty") {
      assert.equal(status.version, "2.0.0");
      assert.equal(status.ruleCount, 1);
      const original = fs.readFileSync(path.join(root, "sast/opengrep-status.json"), "utf8");
      await runOpengrep(snapshot, root, config);
      assert.equal(fs.readFileSync(calls, "utf8"), "scan\n");
      assert.equal(fs.readFileSync(path.join(root, "sast/opengrep-status.json"), "utf8"), original);
    }
    if (mode === "timeout") {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    if (mode === "completed") {
      fs.writeFileSync(path.join(root, "findings.json"), JSON.stringify({ findings: [{ findingId: "ai", title: "AI", severity: "high" }] }));
      assert.equal(readScanFindings(root).length, 2);
      assert.deepEqual(readAiFindingsFile(root).map(finding => finding.findingId), ["ai"], "gate/compare reader excludes unreviewed SAST");
      assert.deepEqual(toFindingSummaries(readScanFindings(root)).map(finding => finding.origin?.kind), ["ai", "sast"]);
    } else if (mode !== "empty") assert.deepEqual(readOpengrepFindings(root), []);
  });
}

for (const exitCode of [0, 2]) {
  test(`valid partial JSON retains findings and safe diagnostics with exit ${exitCode}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-sast-partial-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const rules = path.join(root, "rules.json");
    const results = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((severity, index) => ({
      check_id: `rule-${index}`, path: "source.ts", start: { line: index + 1 }, end: { line: index + 1 },
      extra: { severity, message: "Review code" },
    }));
    fs.writeFileSync(rules, JSON.stringify({ exitCode, payload: { results: [...results, null, {}, { ...results[0], path: "../escape.ts" }, { ...results[0], start: { line: 1, col: { toString: null } } }], errors: [
      { type: "ParseError", message: "secret must not be persisted", path: "/private/secret" },
      { type: "Timeout", rule_id: "secret must not be persisted" },
      { type: "/private/secret", message: "secret must not be persisted" },
      ...Array.from({ length: 25 }, () => ({ type: "UnsupportedLanguage" })),
    ] } }));
    await runOpengrep(root, root, { enabled: true, binary, rules: [rules], timeoutMs: 5000 });
    const status = readOpengrepStatus(root)!;
    assert.equal(status.status, "completed");
    assert.equal(status.reason, null);
    assert.equal(status.count, 4);
    assert.equal(status.errorCount, 32);
    assert.deepEqual(status.errorTypes, ["ParseError", "Timeout", "unknown_error", "UnsupportedLanguage", "invalid_result", "invalid_path"]);
    assert.ok(status.errorTypes.length <= 20);
    assert.ok(!JSON.stringify(status).includes("secret"));
    assert.deepEqual(readOpengrepFindings(root).map(finding => finding.severity), ["critical", "high", "medium", "low"]);
  });
}

test("parseable JSON without results fails safely", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-sast-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rules = path.join(root, "rules.json");
  fs.writeFileSync(rules, JSON.stringify({ exitCode: 2, payload: { errors: [{ type: "ParseError" }] } }));
  await runOpengrep(root, root, { enabled: true, binary, rules: [rules], timeoutMs: 5000 });
  assert.equal(readOpengrepStatus(root)?.status, "failed");
  assert.equal(readOpengrepStatus(root)?.reason, "invalid_result");
  assert.deepEqual(readOpengrepFindings(root), []);
});

test("SAST persistence failure cannot prevent the AI worker from continuing", async () => {
  await assert.doesNotReject(runOpengrep("/does-not-exist", "/dev/null", { enabled: false, binary, rules: [], timeoutMs: 10 }));
});
