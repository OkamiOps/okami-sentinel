import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeGraph, queryGraph } from "./graph-index.js";
import { prepareManagedGraph, managedGraphifyExecutable } from "./managed-graph.js";

test("graph references stay inside the snapshot and preserve uncertain edge provenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-graph-test-"));
  try {
    await fs.writeFile(path.join(root, "route.ts"), "export const route = 1;");
    const graph = normalizeGraph({ nodes: [
      { id: "route", label: "route", source_file: "route.ts" },
      { id: "symbol", label: "symbol", source_file: "route.ts" },
      { id: "escape", source_file: "../outside.ts" },
    ], edges: [
      { source: "route", target: "symbol", relation: "calls", confidence: "INFERRED" },
      { source: "route", target: "escape", relation: "calls" },
    ] }, root);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    const result = JSON.parse(queryGraph(graph, { query: "route" }, 2048));
    assert.equal(result.edges[0].confidence, "INFERRED");
    assert.match(result.note, /Read source/);
    assert.ok(Buffer.byteLength(queryGraph(graph, { query: "route" }, 512)) <= 512);
    assert.throws(() => queryGraph(graph, { query: "route", maxResults: 100 }, 2048));
    assert.throws(() => queryGraph(graph, { query: "route" }, 10));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing runtime is nonfatal and cancellation is never swallowed", async () => {
  const signal = new AbortController();
  const args = { snapshotRoot: os.tmpdir(), snapshotId: "fixture", executable: "/missing/sentinel-graphify", signal: signal.signal };
  assert.equal((await prepareManagedGraph(args)).reason, "runtime_unavailable");
  signal.abort();
  await assert.rejects(prepareManagedGraph(args));
});

test("managed Graphify really extracts cross-file calls and reuses content across snapshot paths", async (t) => {
  const executable = managedGraphifyExecutable();
  try { await fs.access(executable); } catch { t.skip("managed runtime not installed; pnpm setup:graphify enables integration check"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-graph-integration-"));
  try {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "auth.ts"), 'export function authorize(token: string) { return token === "test"; }\n');
    await fs.writeFile(path.join(source, "route.ts"), 'import { authorize } from "./auth";\nexport function route(token: string) { return authorize(token); }\n');
    const options = { snapshotRoot: source, snapshotId: "sha256:fixture-content", cacheRoot: path.join(root, "cache"), signal: new AbortController().signal };
    const first = await prepareManagedGraph(options);
    assert.equal(first.status, "ready", JSON.stringify(first));
    assert.equal(first.cacheHit, false);
    assert.ok(first.index?.edges.some(edge => edge.relation === "calls"));
    const result = JSON.parse(queryGraph(first.index!, { query: "authorize" }, 4096));
    assert.ok(result.nodes.some((node: { file: string }) => node.file === "route.ts"));
    assert.deepEqual((await fs.readdir(source)).sort(), ["auth.ts", "route.ts"], "no artifacts in the source snapshot");
    const moved = path.join(root, "another-snapshot");
    await fs.cp(source, moved, { recursive: true });
    const second = await prepareManagedGraph({ ...options, snapshotRoot: moved });
    assert.equal(second.cacheHit, true);
    assert.deepEqual(second.index, first.index);
    const changed = await prepareManagedGraph({ ...options, snapshotId: "different-content" });
    assert.equal(changed.cacheHit, false);
    const cacheFiles = (await fs.readdir(options.cacheRoot)).filter(name => name.endsWith(".json"));
    for (const filename of cacheFiles) await fs.writeFile(path.join(options.cacheRoot, filename), "invalid");
    const rebuilt = await prepareManagedGraph(options);
    assert.equal(rebuilt.status, "ready");
    assert.equal(rebuilt.cacheHit, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
