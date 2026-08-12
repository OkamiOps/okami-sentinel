import assert from "node:assert/strict";
import test from "node:test";
import { buildScanLineage } from "./index.js";

const input = {
  engine: "codex-security",
  engineVersion: "1.2.3",
  route: "minimax-token-plan",
  protocol: "anthropic-messages",
  provider: "minimax",
  model: "MiniMax-M3",
  reasoningEffort: "provider-default",
  methodology: "portable-codex-security",
  profile: "deep",
  recipeHash: `sha256:${"a".repeat(64)}`,
  sourceRevision: `sha256:${"b".repeat(64)}`,
} as const;

test("builds a deterministic effective scanner lineage", () => {
  const first = buildScanLineage(input);
  const second = buildScanLineage({ ...input });

  assert.match(first.scanLineageHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(first, second);
});

test("changes the lineage for every execution-contract dimension", () => {
  const original = buildScanLineage(input).scanLineageHash;
  const changes = [
    { engine: "mantis" },
    { engineVersion: "1.2.4" },
    { route: "openrouter-api" },
    { protocol: "openai-chat" },
    { provider: "openrouter" },
    { model: "anthropic/claude-opus-5" },
    { reasoningEffort: "xhigh" },
    { methodology: "google-mantis" },
    { profile: "standard" },
    { recipeHash: `sha256:${"c".repeat(64)}` },
    { sourceRevision: `sha256:${"d".repeat(64)}` },
  ];

  for (const change of changes) {
    assert.notEqual(
      buildScanLineage({ ...input, ...change }).scanLineageHash,
      original,
      Object.keys(change)[0],
    );
  }
});

test("rejects unsafe or non-canonical lineage inputs", () => {
  assert.throws(
    () => buildScanLineage({ ...input, engine: "/Users/marcos/private" }),
    /engine/,
  );
  assert.throws(
    () => buildScanLineage({ ...input, recipeHash: "short" }),
    /recipeHash/,
  );
});
