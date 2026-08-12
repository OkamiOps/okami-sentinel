import assert from "node:assert/strict";
import test from "node:test";

import { MAX_AGENT_SESSION_COMPLETION_TOKENS } from "../agent/session-types.js";
import type { PortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";
import { portableCodexSecurityReportCompletionTokens } from "./portable-codex-security-report-budget.js";

test("Portable report completion budget reserves output for every carried coverage entry and confirmed finding", () => {
  const candidates = Array.from({ length: 67 }, (_, index) => ({
    id: `candidate-${index + 1}`,
    category: "injection",
    anchors: [{ path: "src/fixture.ts", startLine: 1, endLine: 1, role: "sink" as const }],
  }));
  const dossier: PortableCodexSecurityDossier = {
    schemaVersion: 1,
    stageSummaries: [],
    candidates,
    assessments: candidates.slice(0, 65).map((candidate) => ({
      candidateId: candidate.id,
      stage: "validation" as const,
      status: "confirmed" as const,
      reason: "untrusted-flow-reaches-sink",
      evidence: candidate.anchors,
    })),
    scope: { inspected: ["src"], unexamined: [] },
  };

  const tokens = portableCodexSecurityReportCompletionTokens(dossier);

  assert.ok(tokens > 10_240);
  assert.ok(tokens <= MAX_AGENT_SESSION_COMPLETION_TOKENS);
});
