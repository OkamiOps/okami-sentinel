import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPortableDeepCoveragePlan,
  mergePortableDeepDiscoveryDossiers,
  readPortableDeepCoveragePartition,
  type PortableDeepCoveragePlan,
} from "./portable-codex-security-deep-coverage.js";
import {
  createPortableCodexSecurityDossier,
  portableCodexSecurityDossierBase64,
} from "./portable-codex-security-dossier.js";

test("Deep merges repeated control claims while preserving affected locations and distinct failures", () => {
  const plan: PortableDeepCoveragePlan = {
    files: ["a.ts", "b.ts"], totalBytes: 20,
    partitions: [
      { index: 0, total: 2, paths: ["a.ts"], fileBytes: { "a.ts": 10 }, bytes: 10 },
      { index: 1, total: 2, paths: ["b.ts"], fileBytes: { "b.ts": 10 }, bytes: 10 },
    ],
  };
  const candidate = {
    id: "page-a", category: "authorization", attacker: "authenticated" as const,
    hypothesis: "The shared write service omits an ownership check.",
    prerequisites: "An ordinary account can call either mutation route.",
    expectedImpact: "Another account's protected records may be modified.",
    controlHypothesis: "The shared service does not bind the record owner to the caller.",
    anchors: [
      { path: "service.ts", startLine: 12, endLine: 12, role: "control" as const },
      { path: "a.ts", startLine: 1, endLine: 1, role: "entrypoint" as const },
    ],
  };
  const repeated = { ...candidate, id: "page-b", anchors: [candidate.anchors[0]!,
    { path: "b.ts", startLine: 1, endLine: 1, role: "entrypoint" as const }] };
  const different = { ...repeated, id: "other-control", anchors: [
    { path: "other-service.ts", startLine: 12, endLine: 12, role: "control" as const },
  ] };
  const differentImpact = { ...repeated, id: "other-impact", expectedImpact: "Protected records may be disclosed through a different operation." };
  const pages = [[candidate], [repeated, different, differentImpact]].map((candidates) => ({
    ...createPortableCodexSecurityDossier(), candidates,
  }));
  const merged = mergePortableDeepDiscoveryDossiers(createPortableCodexSecurityDossier(), pages, plan);
  assert.equal(merged.candidates.length, 3);
  assert.deepEqual(merged.candidates[0]!.anchors.map((anchor) => anchor.path), ["service.ts", "a.ts", "b.ts"]);
  assert.equal(pages[0]!.candidates[0]!.anchors.length, 2, "input checkpoint evidence stays unchanged");
  const roundTrip = JSON.parse(Buffer.from(portableCodexSecurityDossierBase64(merged), "base64").toString());
  assert.equal(roundTrip.candidates[0].hypothesis, candidate.hypothesis);
  const manyLocations = { ...repeated, anchors: [candidate.anchors[0]!, ...Array.from({ length: 19 }, (_, i) => ({
    path: `route-${i}.ts`, startLine: 1, endLine: 1, role: "entrypoint" as const,
  }))] };
  const unmerged = mergePortableDeepDiscoveryDossiers(createPortableCodexSecurityDossier(), [
    pages[0]!, { ...createPortableCodexSecurityDossier(), candidates: [manyLocations] },
  ], plan);
  assert.equal(unmerged.candidates.length, 2, "anchor limits must never silently discard affected locations");
});

test("Deep coverage deterministically partitions every auditable source and configuration file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-deep-coverage-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let index = 0; index < 97; index += 1) {
      fs.writeFileSync(path.join(root, "src", `file-${String(index).padStart(2, "0")}.ts`), "export const value = true;\n");
    }
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    fs.writeFileSync(path.join(root, ".env.example"), "AUTH_MODE=strict\n");
    fs.writeFileSync(path.join(root, "requirements.txt"), "framework==1.0\n");
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(root, "image.png"), "not source\n");
    const plan = createPortableDeepCoveragePlan(root);
    assert.equal(plan.files.length, 100);
    assert.equal(plan.partitions.length, 4);
    assert.ok(plan.partitions.every((partition) => partition.paths.length <= 32));
    assert.deepEqual(createPortableDeepCoveragePlan(root), plan);
    assert.deepEqual(plan.partitions.flatMap((partition) => partition.paths), plan.files);
    assert.equal(new Set(plan.files).size, plan.files.length);
    assert.equal(plan.files.includes("image.png"), false);
    assert.equal(plan.files.includes("package-lock.json"), false);
    assert.equal(plan.files.includes(".env.example"), true);
    assert.equal(plan.files.includes("requirements.txt"), true);
    const sourceFiles = readPortableDeepCoveragePartition(root, plan.partitions[0]!);
    assert.equal(sourceFiles.length, 32);
    assert.equal(sourceFiles.find((file) => file.path === "src/file-00.ts")?.content,
      "export const value = true;\n");
    assert.equal(sourceFiles.find((file) => file.path === "src/file-00.ts")?.lineCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Deep coverage bounds source pages while preserving oversized files without truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-deep-coverage-bytes-"));
  try {
    const contents = new Map([
      ["a.ts", "a".repeat(65_536)],
      ["b.ts", "b".repeat(65_536)],
      ["c.ts", "c".repeat(65_537)],
      ["d.ts", "d".repeat(65_536)],
      ["e.ts", "e".repeat(262_144)],
      ["f.ts", "f".repeat(100)],
    ]);
    for (const [file, content] of contents) fs.writeFileSync(path.join(root, file), content);
    const plan = createPortableDeepCoveragePlan(root);
    assert.deepEqual(plan.partitions.map((partition) => partition.paths), [
      ["a.ts", "b.ts"], ["c.ts"], ["d.ts"], ["e.ts"], ["f.ts"],
    ]);
    assert.equal(plan.totalBytes, [...contents.values()].reduce((sum, content) => sum + content.length, 0));
    assert.deepEqual(plan.partitions.flatMap((partition) => partition.paths), [...contents.keys()]);
    for (const partition of plan.partitions) {
      assert.ok(partition.bytes <= 131_072 || partition.paths.length === 1);
      assert.equal(partition.total, plan.partitions.length);
      for (const file of readPortableDeepCoveragePartition(root, partition)) {
        assert.equal(file.content, contents.get(file.path));
        assert.equal(Buffer.byteLength(file.content), partition.fileBytes[file.path]);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Deep discovery completion is server-owned and requires every planned partition", () => {
  const base = createPortableCodexSecurityDossier();
  const plan: PortableDeepCoveragePlan = {
    files: ["src/a.ts", "src/b.ts"],
    totalBytes: 20,
    partitions: [
      { index: 0, total: 2, paths: ["src/a.ts"], fileBytes: { "src/a.ts": 10 }, bytes: 10 },
      { index: 1, total: 2, paths: ["src/b.ts"], fileBytes: { "src/b.ts": 10 }, bytes: 10 },
    ],
  };
  const pages = plan.partitions.map((partition) => ({
    ...createPortableCodexSecurityDossier(),
    stageSummaries: [{ stage: "discovery" as const, summary: `page ${partition.index}` }],
    candidates: [],
    scope: { inspected: [...partition.paths], unexamined: [] },
  }));
  assert.throws(() => mergePortableDeepDiscoveryDossiers(base, pages.slice(0, 1), plan), {
    message: "deep_coverage_incomplete",
  });
  const merged = mergePortableDeepDiscoveryDossiers(base, pages, plan);
  assert.deepEqual(merged.scope.inspected, plan.files);
  assert.match(merged.stageSummaries.at(-1)?.summary ?? "", /2\/2 auditable files/);
});

test("Deep discovery keeps more than one stage artifact worth of unique candidates", () => {
  const plan: PortableDeepCoveragePlan = {
    files: ["src/a.ts", "src/b.ts"],
    totalBytes: 20,
    partitions: [
      { index: 0, total: 2, paths: ["src/a.ts"], fileBytes: { "src/a.ts": 10 }, bytes: 10 },
      { index: 1, total: 2, paths: ["src/b.ts"], fileBytes: { "src/b.ts": 10 }, bytes: 10 },
    ],
  };
  const pages = plan.partitions.map((partition) => ({
    ...createPortableCodexSecurityDossier(),
    stageSummaries: [{ stage: "discovery" as const, summary: `page ${partition.index}` }],
    candidates: Array.from({ length: 70 }, (_, index) => ({
      id: `page-${partition.index}-candidate-${index}`,
      category: "Security candidate",
      anchors: [{
        path: partition.paths[0]!,
        startLine: 1,
        endLine: 1,
        role: "sink" as const,
        explanation: "Repository-backed candidate evidence.",
      }],
    })),
    scope: { inspected: [...partition.paths], unexamined: [] },
  }));
  const merged = mergePortableDeepDiscoveryDossiers(
    createPortableCodexSecurityDossier(),
    pages,
    plan,
  );
  assert.equal(merged.candidates.length, 140);
  const roundTrip = JSON.parse(
    Buffer.from(portableCodexSecurityDossierBase64(merged), "base64").toString("utf8"),
  ) as { candidates?: unknown[] };
  assert.equal(roundTrip.candidates?.length, 140);
});
