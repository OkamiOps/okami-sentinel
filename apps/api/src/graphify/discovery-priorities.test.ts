import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryPriorities } from "./discovery-priorities.js";
import type { GraphIndex } from "./graph-index.js";

const graph: GraphIndex = { nodes: [
  { id: "entry", file: "routes/upload.ts", label: "upload", location: "L1" },
  { id: "control", file: "auth/guard.ts", label: "authorize", location: "L2" },
  { id: "sink", file: "storage/write.ts", label: "writeFile", location: "L3" },
  { id: "test", file: "auth/guard.test.ts", label: "authorize", location: "L1" },
], edges: [
  { source: "entry", target: "control", relation: "calls", confidence: "EXTRACTED" },
  { source: "control", target: "sink", relation: "calls", confidence: "EXTRACTED" },
] };
test("priorities expose connected source and exclude previously reviewed paths only from suggestions", () => {
  const initial = buildDiscoveryPriorities(graph)!;
  assert.equal(initial.files.length, 3);
  assert.ok(initial.files.find(f => f.path === "auth/guard.ts")!.relatedFiles.includes("routes/upload.ts"));
  assert.equal(initial.files.some(f => f.path.includes(".test.")), false);
  const review = buildDiscoveryPriorities(graph, ["auth/guard.ts"])!;
  assert.equal(review.files.some(f => f.path === "auth/guard.ts"), false);
  assert.equal(review.excludedReviewedFiles, 1);
  assert.ok(review.files.every(file => !file.relatedFiles.includes("auth/guard.ts")), "complementary hints must not steer navigation back to reviewed files");
  assert.match(review.note, /never from permitted inspection/);
});
test("priority envelopes are bounded, deterministic, and inferred relations never affect ordering", () => {
  assert.equal(buildDiscoveryPriorities(graph, [], 8), null);
  assert.deepEqual(buildDiscoveryPriorities({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }), buildDiscoveryPriorities(graph));
  const inferred = { ...graph, edges: graph.edges.map(e => ({ ...e, confidence: "INFERRED" })) };
  assert.ok(buildDiscoveryPriorities(inferred)!.files.every(f => f.crossFileRelations === 0));
  for (const bytes of [700, 1000, 1600]) {
    const output = buildDiscoveryPriorities(graph, [], bytes);
    assert.ok(output === null || Buffer.byteLength(JSON.stringify(output)) <= bytes);
  }
});
