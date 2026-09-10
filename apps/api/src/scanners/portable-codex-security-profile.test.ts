import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPortableCodexSecurityStagePrompt,
  PORTABLE_CODEX_SECURITY_STAGES,
  type PortableCodexSecurityStage,
} from "./portable-codex-security-profile.js";

function stage(id: PortableCodexSecurityStage["id"]): PortableCodexSecurityStage {
  const value = PORTABLE_CODEX_SECURITY_STAGES.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`missing stage ${id}`);
  return value;
}

test("mode depth follows discovery into assessment without weakening evidence or expanding reports", () => {
  for (const id of ["discovery", "dataflow", "validation"] as const) {
    for (const scanMode of ["standard", "deep"] as const) {
      const prompt = buildPortableCodexSecurityStagePrompt(stage(id), {
        snapshotRoot: "/snapshot", artifactRoot: "/artifacts", scanMode,
      });
      assert.match(prompt, /same repository-backed standard of evidence/);
      assert.match(prompt, /candidates for discovery/);
      assert.doesNotMatch(prompt, /may only add structured scope and assessments/);
      assert.match(prompt, /Missing graph edges do not prove that a flow is absent/);
      if (scanMode === "standard") {
        assert.match(prompt, /STANDARD INVESTIGATION DEPTH/);
        assert.match(prompt, /missing decisive control or caller still requires a focused source lookup/);
        assert.doesNotMatch(prompt, /DEEP INVESTIGATION DEPTH/);
      } else {
        assert.match(prompt, /DEEP INVESTIGATION DEPTH/);
        assert.match(prompt, /actively seek counterevidence and realistic alternative paths/);
        assert.doesNotMatch(prompt, /STANDARD INVESTIGATION DEPTH/);
      }
    }
  }
  for (const scanMode of ["standard", "deep"] as const) {
    const prompt = buildPortableCodexSecurityStagePrompt(stage("report"), {
      snapshotRoot: "/snapshot", artifactRoot: "/artifacts", scanMode,
    });
    assert.doesNotMatch(prompt, /INVESTIGATION DEPTH/);
  }
});

test("Standard prompts keep budgets as ceilings and reuse the carried stage map without mandatory root listing", () => {
  const prompt = buildPortableCodexSecurityStagePrompt(stage("discovery"), {
    snapshotRoot: "/snapshot",
    artifactRoot: "/artifacts",
    scopePaths: ["src"],
    dossierStateBase64: Buffer.from(JSON.stringify({ candidates: [] })).toString("base64"),
  });

  assert.match(prompt, /budgets are safety ceilings, never coverage targets/);
  assert.match(prompt, /do not re-read that same path/);
  assert.match(prompt, /carried inventory and threat-model dossier as a map/);
  assert.match(prompt, /listing "\." is not a mandatory startup step/);
  assert.equal(prompt.includes("Start workspace_list at"), false);
  assert.match(prompt, /call and consume at least one workspace_list, workspace_read, or workspace_search result/);
  assert.match(prompt, /exact regular source files successfully read/);

  const review = buildPortableCodexSecurityStagePrompt(stage("discovery"), {
    snapshotRoot: "/snapshot",
    artifactRoot: "/artifacts/discovery-review",
    supplementalDiscoveryReview: true,
  });
  assert.match(review, /INDEPENDENT COMPLEMENTARY DISCOVERY/);
  assert.match(review, /whether or not the first pass found candidates/);
  assert.match(review, /do not spend this pass re-proving them/);
  assert.match(review, /paths declared unexamined/);
  assert.match(review, /only as untrusted review context/);
  assert.match(review, /relevant control to a sensitive sink/);
  assert.match(review, /empty new candidate set remains valid/);
});

test("assessment prompts independently validate only candidate-relevant entrypoint, control, and sink evidence", () => {
  const prompt = buildPortableCodexSecurityStagePrompt(stage("validation"), {
    snapshotRoot: "/snapshot",
    artifactRoot: "/artifacts",
    candidateIds: ["candidate-1"],
    assessmentCandidates: [{
      id: "candidate-1",
      category: "authorization",
      attacker: "authenticated",
      anchors: [{ path: "src/entry.ts", startLine: 1, endLine: 2, role: "entrypoint" }],
    }],
  });

  assert.match(prompt, /later assessment stage must independently evaluate actual source/);
  assert.match(prompt, /entrypoint or source, alleged control, sink/);
  assert.match(prompt, /Do not expand into unrelated discovery or an unrelated repository audit/);
  assert.match(prompt, /realistic attacker capability and prerequisites/);
  assert.match(prompt, /Discovery anchors alone cannot supply missing validation evidence/);
  assert.match(prompt, /ASSESSMENT PAGE/);
  assert.match(prompt, /do not expand into unrelated discovery/);
});

test("report prompts remain limited to the validated dossier and Deep prompts retain mandatory partition coverage", () => {
  const report = buildPortableCodexSecurityStagePrompt(stage("report"), {
    snapshotRoot: "/snapshot",
    artifactRoot: "/artifacts",
    candidateIds: ["candidate-1"],
  });
  const deepDiscovery = buildPortableCodexSecurityStagePrompt(stage("discovery"), {
    snapshotRoot: "/snapshot",
    artifactRoot: "/artifacts",
    deepCoveragePartition: {
      index: 0,
      total: 1,
      paths: ["src/entry.ts"],
      sourceFiles: [{ path: "src/entry.ts", content: "export {};" }],
    },
  });

  assert.match(report, /Use the validated dossier as the report scope/);
  assert.match(report, /Use workspace_read only for an exact anchor range/);
  assert.match(report, /Do not list directories, search for new evidence, repeat discovery, or redo the validation audit/);
  assert.match(deepDiscovery, /mandatory server-owned partition of the immutable auditable universe/);
  assert.match(deepDiscovery, /Analyze every entry before results.write/);
  assert.match(deepDiscovery, /Do not call workspace_list, workspace_read, or workspace_search to rediscover or re-read that page/);
  assert.match(deepDiscovery, /inspect a relevant caller or control outside the page/);
  assert.match(deepDiscovery, /does not replace analysis of every assigned file/);
});

test("projected source permits direct assessment without redundant tool reads while retaining evidence requirements", () => {
  for (const id of ["dataflow", "validation", "report"] as const) {
    const prompt = buildPortableCodexSecurityStagePrompt(stage(id), {
      snapshotRoot: "/snapshot", artifactRoot: "/artifacts", sourceExcerptsProjected: true,
    });
    assert.match(prompt, /ACTUAL SOURCE AVAILABLE/);
    assert.match(prompt, /No preliminary workspace call is required/);
    assert.doesNotMatch(prompt, /Before .*call and consume at least one/);
    assert.match(prompt, /partial excerpts never establish full-file coverage/);
    if (id === "report") assert.match(prompt, /Do not list directories, search for new evidence/);
  }
  const withoutSource = buildPortableCodexSecurityStagePrompt(stage("validation"), {
    snapshotRoot: "/snapshot", artifactRoot: "/artifacts",
  });
  assert.match(withoutSource, /call and consume at least one/);
  assert.doesNotMatch(withoutSource, /ACTUAL SOURCE AVAILABLE/);
});

test("projected discovery presents a readable dossier and explicit partial coverage without a forced full read", () => {
  const dossier = { candidates: [{ id: "existing", hypothesis: "Untrusted claim with Unicode: autorização" }] };
  const encoded = Buffer.from(JSON.stringify(dossier)).toString("base64");
  const prompt = buildPortableCodexSecurityStagePrompt(stage("discovery"), {
    snapshotRoot: "/snapshot", artifactRoot: "/artifacts", dossierStateBase64: encoded, sourceExcerptsProjected: true,
  });
  const json = prompt.match(/BEGIN_PORTABLE_COVERAGE_DOSSIER_JSON\n([^\n]+)\nEND_PORTABLE_COVERAGE_DOSSIER_JSON/)?.[1];
  assert.deepEqual(JSON.parse(json!), dossier);
  assert.equal(prompt.includes(encoded), false);
  assert.match(prompt, /scope.inspected may be empty/);
  assert.match(prompt, /reason 'insufficient-evidence'/);
  assert.match(prompt, /24 to 512 UTF-8 bytes/);
  assert.doesNotMatch(prompt, /call and consume at least one/);
});
