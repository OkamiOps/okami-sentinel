import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createWorkspaceToolHost } from "../agent/workspace-tool-host.js";
import { buildCandidateGraphContext } from "./candidate-context.js";
import type { GraphIndex } from "./graph-index.js";

test("candidate context selects enclosing symbol and direct callers/controls, not unrelated file neighbors", async t => {
  const root = await mkdtemp(join(tmpdir(), "candidate-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotRoot = join(root, "source"); const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot); await mkdir(artifactRoot, { mode: 0o700 });
  await writeFile(join(snapshotRoot, "a.ts"), "function route() {\n check();\n}\nfunction other() {}\n");
  await writeFile(join(snapshotRoot, "control.ts"), "function check() { authorize(); }\n");
  await writeFile(join(snapshotRoot, "caller.ts"), "route();\n");
  await writeFile(join(root, "private"), "SECRET");
  await symlink(join(root, "private"), join(snapshotRoot, "escape.ts"));
  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });
  const index: GraphIndex = { nodes: [
    { id: "a", label: "route", file: "a.ts", location: "1-3" },
    { id: "other", label: "other", file: "a.ts", location: "4" },
    { id: "control", label: "check", file: "control.ts", location: "1" },
    { id: "caller", label: "caller", file: "caller.ts", location: "1" },
    { id: "escape", label: "escape", file: "escape.ts", location: "1" },
  ], edges: [
    { source: "a", target: "control", relation: "calls", confidence: "EXTRACTED" },
    { source: "caller", target: "a", relation: "calls", confidence: "EXTRACTED" },
    { source: "a", target: "escape", relation: "calls", confidence: "EXTRACTED" },
    { source: "a", target: "other", relation: "calls", confidence: "INFERRED" },
  ] };
  const result = await buildCandidateGraphContext(index, [{ path: "a.ts", startLine: 2, endLine: 2 }], host);
  assert.deepEqual(result?.windows.map(w => w.symbol), ["route", "caller", "check"]);
  assert.equal(result?.omittedSymbols, 1);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.match(result!.windows[2].content, /authorize/);
  assert.equal(await buildCandidateGraphContext(index, [], host, 1), null);
  const bounded = await buildCandidateGraphContext(index, [{ path: "a.ts", startLine: 2, endLine: 2 }], host, 600);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 600);
  assert.equal(bounded?.truncated, true);
});

test("large enclosing functions center their source window on candidate lines", async () => {
  const index: GraphIndex = { nodes: [{ id: "long", label: "long", file: "long.ts", location: "1-500" }], edges: [] };
  const calls: unknown[] = [];
  const result = await buildCandidateGraphContext(index, [{ path: "long.ts", startLine: 300, endLine: 302 }], {
    minimumOutputBytes: () => 0,
    async call(_name, input) { calls.push(input); return { content: JSON.stringify({ content: "source evidence" }) }; },
  });
  assert.deepEqual(calls, [{ path: "long.ts", startLine: 292, endLine: 371, maxBytes: 4096 }]);
  assert.equal(result?.windows[0].startLine, 292);
  assert.equal(result?.windows[0].endLine, 371);
});

test("candidate expansion reads a bounded neighborhood even if every source path is denied", async () => {
  const index: GraphIndex = {
    nodes: Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, file: `n${i}.ts`, location: "1" })),
    edges: Array.from({ length: 49 }, (_, i) => ({ source: "n0", target: `n${i + 1}`, relation: "calls", confidence: "EXTRACTED" })),
  };
  let reads = 0;
  const result = await buildCandidateGraphContext(index, [{ path: "n0.ts", startLine: 1, endLine: 1 }], {
    minimumOutputBytes: () => 0,
    async call() { reads++; throw new Error("tool_path_denied"); },
  });
  assert.equal(reads, 12);
  assert.equal(result?.omittedSymbols, 50);
  assert.equal(result?.windows.length, 0);
});


test("point declaration locations infer ownership only until the next symbol", async () => {
  const graph: GraphIndex = { nodes: [
    { id: "route", label: "route", file: "a.ts", location: "L10" },
    { id: "next", label: "next", file: "a.ts", location: "L40" },
    { id: "control", label: "control", file: "b.ts", location: "L5" },
    { id: "next-control", label: "nextControl", file: "b.ts", location: "L15" },
  ], edges: [{ source: "route", target: "control", relation: "calls", confidence: "EXTRACTED" }] };
  const context = await buildCandidateGraphContext(graph, [{ path: "a.ts", startLine: 25, endLine: 25 }], {
    minimumOutputBytes: () => 0,
    async call() { return { content: JSON.stringify({ content: "source" }) }; },
  });
  assert.deepEqual(context?.windows.map(w => [w.symbol, w.startLine, w.endLine]), [["route", 17, 39], ["control", 5, 14]]);
  assert.ok(context?.windows.every(w => w.boundary === "next-symbol-inferred"));
});
