import assert from "node:assert/strict";
import test from "node:test";
import { queryGraph, type GraphIndex, type GraphNode } from "./graph-index.js";

const node = (id: string, label = id, file = `${id}.ts`): GraphNode => ({ id, label, file, location: "1" });
const edge = (source: string, target: string) => ({ source, target, relation: "calls", confidence: "EXTRACTED" });

test("graph query ranks exact symbols and paths before substring matches deterministically", () => {
  const nodes = [node("alphabet", "authorizeHelper", "a.ts"), node("auth", "authorize", "z.ts"), node("other", "Authorize", "b.ts")];
  const run = (nodes: GraphNode[]) => JSON.parse(queryGraph({ nodes, edges: [] }, { query: "authorize", maxResults: 1 }, 4096));
  assert.equal(run(nodes).nodes[0].id, "other");
  assert.deepEqual(run(nodes), run([...nodes].reverse()));
  const paths = JSON.parse(queryGraph({ nodes: [node("a", "x", "other/auth.ts"), node("b", "y", "auth.ts")], edges: [] }, { query: "auth.ts", maxResults: 1 }, 4096));
  assert.equal(paths.nodes[0].id, "b");
  assert.equal(paths.matchesTotal, 2);
  assert.equal(paths.matchesReturned, 1);
  assert.equal(paths.resultsTruncated, true);
  assert.equal(paths.neighborhoodTruncated, false);
});

test("graph no-match and complete match responses report truthful completeness of returned graph query", () => {
  const index = { nodes: [node("a")], edges: [] };
  const missing = JSON.parse(queryGraph(index, { query: "missing" }, 4096));
  assert.equal(missing.matchesTotal, 0);
  assert.equal(missing.matchesReturned, 0);
  assert.equal(missing.truncated, false);
  assert.equal(missing.resultsTruncated, false);
  assert.equal(missing.neighborhoodTruncated, false);
  assert.deepEqual(missing.nodes, []);
  assert.match(missing.note, /Missing edges do not prove absence/);
  assert.equal(JSON.parse(queryGraph(index, { query: "a" }, 4096)).truncated, false);
});

test("graph returns bounded one-hop neighbors and does not expand newly returned nodes", () => {
  const index: GraphIndex = { nodes: [node("root"), node("b"), node("c"), node("d"), node("e")],
    edges: [edge("root", "b"), edge("root", "c"), edge("root", "d"), edge("b", "e")] };
  const result = JSON.parse(queryGraph(index, { query: "root", maxResults: 1 }, 4096));
  assert.equal(result.matchesReturned, 1);
  assert.equal(result.neighborhoodEdgesTotal, 3);
  assert.equal(result.neighborhoodEdgesReturned, 2);
  assert.equal(result.resultsTruncated, false);
  assert.equal(result.neighborhoodTruncated, true);
  assert.equal(result.truncated, true);
  assert.ok(!result.nodes.some((n: GraphNode) => n.id === "e"));
  assert.equal(result.nodes.length, 3);
});

test("graph output accounts for metadata overhead and escaped multibyte content at every byte bound", () => {
  const index = { nodes: [node("seed"), node("neighbor", "é\\\"".repeat(200))], edges: [edge("seed", "neighbor")] };
  const full = queryGraph(index, { query: "seed" }, 4096);
  let sawDroppedNeighbor = false;
  let sawDroppedSeed = false;
  for (let budget = 1; budget <= Buffer.byteLength(full); budget++) {
    try {
      const content = queryGraph(index, { query: "seed" }, budget);
      assert.ok(Buffer.byteLength(content) <= budget);
      const result = JSON.parse(content);
      assert.equal(result.truncated, result.resultsTruncated || result.neighborhoodTruncated);
      if (result.matchesReturned === 0) sawDroppedSeed = true;
      if (result.matchesReturned === 1 && result.neighborhoodEdgesReturned === 0) {
        sawDroppedNeighbor = true;
        assert.equal(result.neighborhoodTruncated, true);
      }
    } catch (error) {
      assert.equal((error as Error).message, "agent_output_byte_limit");
    }
  }
  assert.equal(sawDroppedNeighbor, true);
  assert.equal(sawDroppedSeed, true);
});
