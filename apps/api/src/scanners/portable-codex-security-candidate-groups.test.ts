import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PORTABLE_CANDIDATE_GROUPS_FILE,
  applyPortableCandidateGrouping,
  groupPortableCandidates,
  groupPortableCandidatesBeforeReview,
  readPortableCandidateGrouping,
} from "./portable-codex-security-candidate-groups.js";
import { createPortableCodexSecurityDossier, type PortableCandidate } from "./portable-codex-security-dossier.js";

function candidate(id: string, patch: Partial<PortableCandidate> = {}): PortableCandidate {
  return {
    id,
    category: "authorization",
    hypothesis: `Hypothesis worded by pass ${id}.`,
    attacker: "authenticated",
    prerequisites: "An ordinary account.",
    expectedImpact: "Cross-tenant read.",
    controlHypothesis: "The tenant check is missing.",
    anchors: [
      { path: "src/orders.ts", startLine: 10, endLine: 14, role: "control" },
      { path: "src/orders.ts", startLine: 20, endLine: 20, role: "sink" },
    ],
    ...patch,
  };
}

test("reworded duplicates of the same control and sink form one group reviewed once", () => {
  const { candidates, grouping } = groupPortableCandidates([
    candidate("a"),
    candidate("b", {
      category: " Authorization ",
      hypothesis: "Another pass phrased the same missing tenant check differently.",
      anchors: [
        { path: "src/orders.ts", startLine: 12, endLine: 16, role: "control" },
        { path: "src/orders.ts", startLine: 20, endLine: 21, role: "sink" },
      ],
    }),
    candidate("c"),
  ]);
  assert.deepEqual(candidates.map((item) => item.id), ["a"]);
  assert.deepEqual(grouping.groups.map((group) => [group.representativeId, group.memberIds]), [["a", ["a", "b", "c"]]]);
  assert.deepEqual(candidates[0]!.anchors.map((anchor) => `${anchor.role}:${anchor.startLine}-${anchor.endLine}`), [
    "control:10-14", "sink:20-20", "control:12-16", "sink:20-21",
  ]);
  assert.equal(grouping.groups[0]!.members[1]!.hypothesis, "Another pass phrased the same missing tenant check differently.");
  assert.deepEqual(groupPortableCandidates([candidate("a"), candidate("b"), candidate("c")]), groupPortableCandidates([candidate("a"), candidate("b"), candidate("c")]));
});

test("distinct causes or locations are never merged", () => {
  const distinct = [
    candidate("base"),
    candidate("category", { category: "injection" }),
    candidate("attacker", { attacker: "unauthenticated" }),
    candidate("file", { anchors: [{ path: "src/invoices.ts", startLine: 10, endLine: 14, role: "control" }] }),
    candidate("lines", { anchors: [{ path: "src/orders.ts", startLine: 15, endLine: 18, role: "control" }] }),
    candidate("role", { anchors: [{ path: "src/orders.ts", startLine: 10, endLine: 14, role: "sink" }] }),
    candidate("sink", { anchors: [
      { path: "src/orders.ts", startLine: 10, endLine: 14, role: "control" },
      { path: "src/orders.ts", startLine: 40, endLine: 40, role: "sink" },
    ] }),
  ];
  const { candidates, grouping } = groupPortableCandidates(distinct);
  assert.deepEqual(candidates.map((item) => item.id), distinct.map((item) => item.id));
  assert.deepEqual(candidates, distinct);
  assert.deepEqual(grouping.groups, []);
});

test("historical candidates without a recorded hypothesis stay separate", () => {
  const legacy = (id: string): PortableCandidate => ({
    id, category: "authorization", anchors: [{ path: "src/orders.ts", startLine: 10, endLine: 14, role: "control" }],
  });
  const { candidates, grouping } = groupPortableCandidates([legacy("old-a"), legacy("old-b"), candidate("new")]);
  assert.deepEqual(candidates.map((item) => item.id), ["old-a", "old-b", "new"]);
  assert.deepEqual(grouping.groups, []);
});

test("a group never exceeds the 20 anchors a finding can carry", () => {
  const wide = (id: string, offset: number) => candidate(id, { anchors: [
    { path: "src/orders.ts", startLine: 10, endLine: 14, role: "control" },
    ...Array.from({ length: 11 }, (_, index) => ({ path: "src/orders.ts", startLine: 100 + offset + index, endLine: 100 + offset + index, role: "evidence" as const })),
  ] });
  const { candidates } = groupPortableCandidates([wide("a", 0), wide("b", 50)]);
  assert.deepEqual(candidates.map((item) => item.id), ["a", "b"]);
});

test("grouping is recorded once and reused or skipped on resume", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-candidate-groups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dossier = { ...createPortableCodexSecurityDossier(), candidates: [candidate("a"), candidate("b")] };
  const fresh = groupPortableCandidatesBeforeReview(dossier, root, { resume: false, persist: true });
  assert.deepEqual(fresh.candidates.map((item) => item.id), ["a"]);
  assert.deepEqual(readPortableCandidateGrouping(root), applyPortableCandidateGrouping(dossier).grouping);
  assert.deepEqual(groupPortableCandidatesBeforeReview(dossier, root, { resume: true, persist: true }), fresh);
  const changed = { ...dossier, candidates: [candidate("a"), candidate("b", { category: "injection" })] };
  assert.throws(() => groupPortableCandidatesBeforeReview(changed, root, { resume: true, persist: true }), /candidate_grouping_mismatch/);
  fs.writeFileSync(path.join(root, PORTABLE_CANDIDATE_GROUPS_FILE), "{");
  assert.throws(() => groupPortableCandidatesBeforeReview(dossier, root, { resume: true, persist: true }), /candidate_grouping_invalid/);

  const legacyRun = path.join(root, "legacy");
  fs.mkdirSync(path.join(legacyRun, "dataflow"), { recursive: true });
  assert.deepEqual(groupPortableCandidatesBeforeReview(dossier, legacyRun, { resume: true, persist: true }), dossier);
  assert.equal(fs.existsSync(path.join(legacyRun, PORTABLE_CANDIDATE_GROUPS_FILE)), false);
  const preview = path.join(root, "preview");
  fs.mkdirSync(preview);
  groupPortableCandidatesBeforeReview(dossier, preview, { resume: true, persist: false });
  assert.deepEqual(fs.readdirSync(preview), []);
});
