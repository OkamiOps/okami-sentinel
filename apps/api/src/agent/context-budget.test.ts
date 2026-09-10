import assert from "node:assert/strict";
import test from "node:test";
import { ContextBudgetEstimator, completionContextReserve } from "./context-budget.js";
import { createConstrainedWireSession, type AgentSessionLimits } from "./session-types.js";

const limits: AgentSessionLimits = { maxModelTurns: 16, maxToolCalls: 20, maxInputBytes: 1_048_576, maxOutputBytes: 65_536, timeoutMs: 0 };
function run(bodies: unknown[], maxContextTokens?: number, inputTokens: number | null = null) {
  let requests = 0;
  const session = createConstrainedWireSession({ limits: { ...limits, maxContextTokens }, signal: new AbortController().signal,
    host: { minimumOutputBytes() { return 1; }, async call() { return { content: "evidence" }; } },
    upstream: { async request() { requests++; return {}; } },
    adapter: {
      nextRequest() { return { operation: "responses", body: bodies.shift() }; },
      readResponse() { return { toolCalls: bodies.length ? [{ id: `read-${requests}`, name: "workspace.read", input: { path: "a.ts" } }] : [],
        text: "done", structured: null, usage: { inputTokens, cachedInputTokens: inputTokens, cacheWriteInputTokens: null, outputTokens: 1, reasoningTokens: null } }; },
    },
  });
  return { requests: () => requests, async consume() { for await (const _ of session.run()) { /* consume */ } } };
}

test("context preflight counts instructions, tools and messages before any upstream call", async () => {
  const attempt = run([{ instructions: "i".repeat(8_000), tools: [{ description: "t".repeat(8_000) }], input: "m".repeat(8_000), max_output_tokens: 1_000 }], 10_000);
  await assert.rejects(attempt.consume(), { code: "agent_context_limit" });
  assert.equal(attempt.requests(), 0);
});

test("context growth fails before the oversized next request", async () => {
  const attempt = run([{ input: "small", max_output_tokens: 1_000 }, { input: "large".repeat(5_000), max_output_tokens: 1_000 }], 10_000);
  await assert.rejects(attempt.consume(), { code: "agent_context_limit" });
  assert.equal(attempt.requests(), 1);
});

test("completion reserve leaves capacity for provider output", async () => {
  const attempt = run([{ input: "small", max_tokens: 9_000 }], 10_000);
  await assert.rejects(attempt.consume(), { code: "agent_context_limit" });
  assert.equal(attempt.requests(), 0);
  assert.equal(completionContextReserve({}), 65_536);
});

test("provider input usage including cached input calibrates future estimates upward", async () => {
  const attempt = run([{ input: "small", max_tokens: 1_000 }, { input: "small", max_tokens: 1_000 }], 10_000, 9_000);
  await assert.rejects(attempt.consume(), { code: "agent_context_limit" });
  assert.equal(attempt.requests(), 1);
  const estimator = new ContextBudgetEstimator();
  estimator.observe(1_000, 2_000);
  assert.ok(estimator.estimate(2_000) > 4_000);
  estimator.observe(1_000, null);
  assert.ok(estimator.estimate(2_000) > 4_000);
});

test("sessions without context limit retain previous behavior", async () => {
  const attempt = run([{ input: "large".repeat(5_000), max_tokens: 65_536 }]);
  await attempt.consume();
  assert.equal(attempt.requests(), 1);
});

test("invalid context limit is rejected as a spec error", () => {
  for (const value of [0, -1, 1.5, NaN, 2_000_001]) assert.throws(() => run([{}], value), { code: "runner_invalid_spec" });
});

test("range evidence never marks a file as fully reviewed in Standard or Deep", async () => {
  const standardReads = new Set<string>(), deepReads = new Set<string>();
  let turn = 0;
  const session = createConstrainedWireSession({ limits, signal: new AbortController().signal,
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactValidationContext: {
      expectedArtifactPath: "03-discovery.json", discoveryCoverage: { observedReadPaths: standardReads },
      deepCoverage: { index: 1, total: 1, requiredPaths: ["range.ts", "full.ts"], requiredBytes: { "range.ts": 100, "full.ts": 100 }, observedReadPaths: deepReads },
      dossier: { schemaVersion: 1, stageSummaries: [], candidates: [], assessments: [], scope: { inspected: [], unexamined: [] } },
    },
    host: { minimumOutputBytes() { return 1; }, async call() { return { content: "evidence" }; } },
    upstream: { async request() { return {}; } },
    adapter: { nextRequest() { return { operation: "responses", body: {} }; }, readResponse() {
      return { toolCalls: turn++ === 0 ? [
        { id: "range", name: "workspace.read", input: { path: "range.ts", startLine: 1, endLine: 2, maxBytes: 100 } },
        { id: "full", name: "workspace.read", input: { path: "full.ts", maxBytes: 100 } },
      ] : [], text: "done", structured: null, usage: null };
    } },
  });
  for await (const _ of session.run()) { /* consume */ }
  assert.deepEqual([...standardReads], ["full.ts"]);
  assert.deepEqual([...deepReads], ["full.ts"]);
});

test("Responses continuation carries total history without dividing usage by tiny deltas", () => {
  const estimator = new ContextBudgetEstimator();
  estimator.observe(200_000, 60_000, false, 5_000);
  assert.equal(estimator.estimate(2_000, true), 68_048);
  estimator.observe(2_000, 66_000, true, 1_000);
  assert.equal(estimator.estimate(2_000, true), 70_048);
  estimator.observe(2_000, null, true, null, 8_000);
  assert.equal(estimator.estimate(2_000, true), 81_096);
});

test("Responses continuation exceeds ceiling before another upstream call", async () => {
  const attempt = run([{ input: "initial", max_tokens: 1_000 }, { previous_response_id: "remote-id", input: "delta", max_tokens: 1_000 }], 10_000, 8_000);
  await assert.rejects(attempt.consume(), { code: "agent_context_limit" });
  assert.equal(attempt.requests(), 1);
});

for (const changes of [false, true]) test(`identical invalid artifacts stop after three failures; changed payloads allowed: ${changes}`, async () => {
  let requests = 0;
  const session = createConstrainedWireSession({ limits, terminalMode: "artifact-write", signal: new AbortController().signal,
    host: { minimumOutputBytes() { return 1; }, async call() { return { content: "ok", artifact: { path: "report.json", bytes: 2 } }; } },
    upstream: { async request() { requests++; return {}; } },
    adapter: { nextRequest() { return { operation: "responses", body: {} }; }, readResponse() {
      return { toolCalls: [{ id: `write-${requests}`, name: "results.write", input: { path: "report.json",
        content: changes && requests === 4 ? "{}" : `{invalid${changes ? requests : ""}` } }], text: null, structured: null, usage: null };
    } },
  });
  const consume = async () => { for await (const _ of session.run()) { /* consume */ } };
  if (changes) { await consume(); assert.equal(requests, 4); }
  else { await assert.rejects(consume(), { code: "agent_artifact_stalled" }); assert.equal(requests, 3); }
});
