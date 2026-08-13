import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPortableDeepCoveragePlan,
  mergePortableDeepDiscoveryDossiers,
  type PortableDeepCoveragePlan,
} from "./portable-codex-security-deep-coverage.js";
import { createPortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";

test("Deep coverage deterministically partitions every auditable source and configuration file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-deep-coverage-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      fs.writeFileSync(path.join(root, "src", `file-${String(index).padStart(2, "0")}.ts`), "export const value = true;\n");
    }
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    fs.writeFileSync(path.join(root, ".env.example"), "AUTH_MODE=strict\n");
    fs.writeFileSync(path.join(root, "requirements.txt"), "framework==1.0\n");
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(root, "image.png"), "not source\n");
    const plan = createPortableDeepCoveragePlan(root);
    assert.equal(plan.files.length, 53);
    assert.equal(plan.partitions.length, 2);
    assert.ok(plan.partitions.every((partition) => partition.paths.length <= 48));
    assert.deepEqual(plan.partitions.flatMap((partition) => partition.paths), plan.files);
    assert.equal(new Set(plan.files).size, plan.files.length);
    assert.equal(plan.files.includes("image.png"), false);
    assert.equal(plan.files.includes("package-lock.json"), false);
    assert.equal(plan.files.includes(".env.example"), true);
    assert.equal(plan.files.includes("requirements.txt"), true);
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
