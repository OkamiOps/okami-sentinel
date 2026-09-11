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
  const bounded = await buildCandidateGraphContext(index, [{ path: "a.ts", startLine: 2, endLine: 2 }], host, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1000);
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

test("three-hop navigation exposes exact directions, prioritizes control hints and excludes fourth-hop nodes", async () => {
  const names = ["route", "service", "wrapper", "authorize", "fourth", "unrelated"];
  const graph: GraphIndex = { nodes: names.map(id => ({ id, label: id, file: `${id}.ts`, location: "1-3" })),
    edges: [
      ...[["route", "service"], ["service", "wrapper"], ["wrapper", "authorize"], ["authorize", "fourth"], ["wrapper", "route"]]
        .map(([source, target]) => ({ source: source!, target: target!, relation: "calls", confidence: "EXTRACTED" })),
      { source: "route", target: "unrelated", relation: "calls", confidence: "INFERRED" },
    ] };
  // Without the cycle shortcut, authorize is exactly three calls away.
  graph.edges = graph.edges.filter(e => !(e.source === "wrapper" && e.target === "route"));
  const context = await buildCandidateGraphContext(graph, [{ path: "route.ts", startLine: 2, endLine: 2 }], {
    minimumOutputBytes: () => 0,
    async call() { return { content: JSON.stringify({ content: "source" }) }; },
  });
  assert.deepEqual(context?.windows.map(w => w.symbol), ["route", "authorize", "service", "wrapper"]);
  const control = context!.windows[1]!;
  assert.equal(control.selection, "control-name-hint");
  assert.deepEqual(control.navigationPath.map(step => [step.from.symbol, step.to.symbol, step.traversal]),
    [["route", "service", "callee"], ["service", "wrapper", "callee"], ["wrapper", "authorize", "callee"]]);
  assert.equal(context?.windows.some(w => ["fourth", "unrelated"].includes(w.symbol)), false);
  assert.match(context!.note, /not executable attacker flows/);
});

test("caller-to-control paths retain reverse steps and terminate cycles deterministically", async () => {
  const graph: GraphIndex = { nodes: ["sink", "caller", "guard", "other"].map(id => ({ id, label: id, file: `${id}.ts`, location: "1" })),
    edges: [["caller", "sink"], ["caller", "guard"], ["guard", "other"], ["other", "caller"]]
      .map(([source, target]) => ({ source: source!, target: target!, relation: "calls", confidence: "EXTRACTED" })) };
  const host = { minimumOutputBytes: () => 0, async call() { return { content: JSON.stringify({ content: "source" }) }; } };
  const anchors = [{ path: "sink.ts", startLine: 1, endLine: 1 }];
  const first = await buildCandidateGraphContext(graph, anchors, host);
  const second = await buildCandidateGraphContext({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, anchors, host);
  assert.deepEqual(first, second);
  assert.equal(first?.visitedSymbols, 4);
  assert.deepEqual(first?.windows.find(w => w.symbol === "guard")?.navigationPath.map(s => s.traversal), ["caller", "callee"]);
});

test("dense graph traversal limits are explicit and source reads remain bounded", async () => {
  const graph: GraphIndex = { nodes: Array.from({ length: 1200 }, (_, i) => ({ id: String(i), label: String(i), file: `${i}.ts`, location: "1" })),
    edges: Array.from({ length: 1199 }, (_, i) => ({ source: "0", target: String(i + 1), relation: "calls", confidence: "EXTRACTED" })) };
  let reads = 0;
  const context = await buildCandidateGraphContext(graph, [{ path: "0.ts", startLine: 1, endLine: 1 }], {
    minimumOutputBytes: () => 0, async call() { reads++; return { content: JSON.stringify({ content: "source" }) }; },
  });
  assert.equal(context?.traversalTruncated, true);
  assert.equal(context?.truncated, true);
  assert.equal(context?.visitedSymbols, 1024);
  assert.ok(context!.inspectedEdges <= 4096);
  assert.ok(reads <= 12);
  assert.ok(context!.windows.length <= 8);
});

test("eight candidate seeds retain control paths fairly instead of filling every window with anchors", async () => {
  const graph: GraphIndex = { nodes: [], edges: [] };
  const anchors = [];
  for (let i = 0; i < 8; i++) {
    const seed = `seed${i}`, via = `via${i}`, control = `authorize${i}`;
    anchors.push({ path: `${seed}.ts`, startLine: 1, endLine: 1 });
    for (const id of [seed, via, control]) graph.nodes.push({ id, label: id, file: `${id}.ts`, location: "1-2" });
    graph.edges.push({ source: seed, target: via, relation: "calls", confidence: "EXTRACTED" },
      { source: via, target: control, relation: "calls", confidence: "EXTRACTED" });
  }
  const context = await buildCandidateGraphContext(graph, anchors, {
    minimumOutputBytes: () => 0, async call() { return { content: JSON.stringify({ content: "source" }) }; },
  });
  assert.equal(context?.windows.length, 8);
  assert.equal(context?.windows.filter(w => w.selection !== "anchor").length, 8);
  assert.deepEqual(context?.windows.map(w => w.symbol).sort(), Array.from({ length: 8 }, (_, i) => `authorize${i}`));
  assert.ok(context?.windows.every(w => w.navigationPath.length === 2));
  assert.equal(new Set(context?.windows.map(w => w.navigationPath[0]?.from.symbol)).size, 8);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 16_384);
});

test("a single connected seed among eight cannot lose its reserved neighbor slots to anchor excerpts", async () => {
  const seeds = Array.from({ length: 8 }, (_, i) => `seed${i}`);
  const neighbors = Array.from({ length: 6 }, (_, i) => `authorize${i}`);
  const graph: GraphIndex = { nodes: [...seeds, ...neighbors].map(id => ({ id, label: id, file: `${id}.ts`, location: "1" })),
    edges: neighbors.map(target => ({ source: "seed0", target, relation: "calls", confidence: "EXTRACTED" })) };
  const context = await buildCandidateGraphContext(graph, seeds.map(seed => ({ path: `${seed}.ts`, startLine: 1, endLine: 1 })), {
    minimumOutputBytes: () => 0, async call() { return { content: JSON.stringify({ content: "source" }) }; },
  });
  assert.ok(context!.windows.filter(w => w.selection !== "anchor").length >= 4);
  assert.ok(context!.windows.length <= 8);
});

test("a huge first neighborhood cannot consume traversal budget reserved for later candidates", async () => {
  const seeds = Array.from({ length: 8 }, (_, i) => `seed${i}`);
  const graph: GraphIndex = { nodes: seeds.map(id => ({ id, label: id, file: `${id}.ts`, location: "1" })), edges: [] };
  for (let seed = 0; seed < 8; seed++) {
    for (let i = 0; i < (seed === 0 ? 1100 : 1); i++) {
      const id = `authorize-${seed}-${i}`;
      graph.nodes.push({ id, label: id, file: `${id}.ts`, location: "1" });
      graph.edges.push({ source: `seed${seed}`, target: id, relation: "calls", confidence: "EXTRACTED" });
    }
  }
  const context = await buildCandidateGraphContext(graph, seeds.map(seed => ({ path: `${seed}.ts`, startLine: 1, endLine: 1 })), {
    minimumOutputBytes: () => 0, async call() { return { content: JSON.stringify({ content: "source" }) }; },
  });
  assert.equal(context?.traversalTruncated, true);
  assert.equal(new Set(context?.windows.map(w => w.navigationPath[0]?.from.symbol)).size, 8);
  assert.ok(context!.visitedSymbols <= 1024);
  assert.ok(context!.inspectedEdges <= 4096);
});

test("assessment context supplies every candidate anchor and related controls beyond eight windows", async () => {
  const graph: GraphIndex = { nodes: [], edges: [] };
  const anchors = [];
  for (let i = 0; i < 16; i++) {
    anchors.push({ path: `route${i}.ts`, startLine: 10, endLine: 15 });
    graph.nodes.push({ id: `r${i}`, label: `route${i}`, file: `route${i}.ts`, location: "1-100" },
      { id: `c${i}`, label: `authorize${i}`, file: `control${i}.ts`, location: "1-100" });
    graph.edges.push({ source: `r${i}`, target: `c${i}`, relation: "calls", confidence: "EXTRACTED" });
  }
  const host = { minimumOutputBytes: () => 0, async call() { return { content: JSON.stringify({ content: "verified source\n".repeat(80) }) }; } };
  const old = await buildCandidateGraphContext(graph, anchors, host, 16_384);
  const result = await buildCandidateGraphContext(graph, anchors, host, 196_608);
  assert.ok(old!.windows.length <= 8);
  assert.equal(result!.windows.length, 32);
  assert.equal(result!.windows.filter(w => w.selection === "anchor").length, 16);
  assert.equal(result!.windows.filter(w => w.selection !== "anchor").length, 16);
  assert.ok(result!.windows.every(w => w.startLine === 1 && w.endLine === 100));
  assert.equal(result!.truncated, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 196_608);
});

test("adaptive projection removes window and function-length caps and identifies omitted ranges", async () => {
  const nodes = Array.from({length:60},(_,i)=>({id:`f${i}`,label:`f${i}`,file:`f${i}.ts`,location:'1-500'}));
  const anchors=nodes.map(n=>({path:n.file,startLine:1,endLine:2}));
  const graph: GraphIndex={nodes,edges:[]};
  let reads=0;
  const host={minimumOutputBytes:()=>0,async call(){reads++;return {content:JSON.stringify({content:'source'})};}};
  const full=await buildCandidateGraphContext(graph,anchors,host,250000,true);
  assert.equal(full!.windows.length,60);
  assert.equal(reads,120);
  assert.equal(full!.pending!.length,0);
  assert.ok(full!.windows.every(w=>w.endLine===500));
  const small=await buildCandidateGraphContext(graph,anchors,host,6000,true);
  assert.ok(small!.pending!.length>0);
  assert.equal(small!.pending!.length+small!.windows.length,60);
  assert.ok(Buffer.byteLength(JSON.stringify(small))<=6000);
});
