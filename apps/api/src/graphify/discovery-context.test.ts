import assert from "node:assert/strict";
import test from "node:test";
import { buildDiscoveryGraphContext } from "./discovery-context.js";
import type { GraphIndex } from "./graph-index.js";

test("discovery projects actual source plus extracted caller/control relationships within a bounded context", async () => {
  const index: GraphIndex = { nodes: [
    { id: "entry", label: "upload", file: "route.ts", location: "1-30" },
    { id: "control", label: "authorize", file: "guard.ts", location: "1-10" },
    { id: "unrelated", label: "unrelated", file: "other.ts", location: "1-10" },
  ], edges: [
    { source: "entry", target: "control", relation: "calls", confidence: "EXTRACTED" },
    { source: "entry", target: "unrelated", relation: "calls", confidence: "INFERRED" },
  ] };
  const reads: string[] = [];
  const context = await buildDiscoveryGraphContext(index, ["route.ts"], {
    minimumOutputBytes: () => 0,
    async call(_name, input) {
      reads.push((input as { path: string }).path);
      return { content: JSON.stringify({ content: "actual immutable source" }) };
    },
  });
  assert.deepEqual(reads, ["route.ts", "guard.ts"]);
  assert.equal(context!.windows[1].navigationPath[0].to.path, "guard.ts");
  assert.equal(context!.windows[0].content, "actual immutable source");
  assert.equal(context!.truncated, true);
  assert.match(context!.note, /scope.unexamined/);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 24_576);
});

test("discovery limits source work and preserves an empty projection when references cannot be read", async () => {
  const index: GraphIndex = { nodes: Array.from({ length: 40 }, (_, i) =>
    ({ id: String(i), label: "authorize", file: `${i}.ts`, location: "1-500" })), edges: [] };
  let reads = 0;
  const result = await buildDiscoveryGraphContext(index, index.nodes.map(node => node.file), {
    minimumOutputBytes: () => 0,
    async call() { reads++; throw new Error("tool_path_denied"); },
  });
  assert.ok(reads <= 24);
  assert.deepEqual(result!.windows, []);
  assert.equal(result!.anchorsTruncated, true);
});
