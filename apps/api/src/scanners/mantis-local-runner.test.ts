import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProviderModel, ScanConnectionSnapshot } from "@csb/shared";

import type { StoredProviderConnection } from "../connections-store.js";
import type {
  DefensiveLocalCli,
  DefensiveLocalCliInput,
} from "../agent/defensive-local-cli.js";
import { DefensiveLocalCliError } from "../agent/defensive-local-cli.js";
import {
  MantisLocalRunnerError,
  runMantisLocalClaude,
  type MantisLocalProviderPlan,
} from "./mantis-local-runner.js";

const NOW = new Date("2026-08-11T15:00:00.000Z");
const STAGES = [
  "architecture", "threat-model", "plan", "researcher", "dedupe",
  "review", "critic", "calibrate", "report",
];

function connection(patch: Partial<StoredProviderConnection> = {}): StoredProviderConnection {
  return {
    id: "claude-local",
    scopeId: "local",
    name: "Claude Code",
    providerKind: "anthropic",
    routeKind: "claude-code-local",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "claude-code-cli",
    status: "ready",
    credentialRef: null,
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: NOW.toISOString(),
    lastModelSyncAt: NOW.toISOString(),
    modelCatalogStale: false,
    display: {
      providerLabel: "Claude",
      routeLabel: "Local CLI",
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: "preset",
    },
    ...patch,
  };
}

function model(patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: "claude-local",
    id: "claude-opus-4-1",
    displayName: "Claude Opus 4.1",
    contextWindow: 200_000,
    capabilities: {
      tools: "unsupported",
      artifactOutput: "unsupported",
      structuredOutput: "unsupported",
      boundedExecution: "unsupported",
      osIsolation: "unsupported",
      streaming: "unsupported",
      usage: "unsupported",
      cancellation: "unsupported",
    },
    pricing: null,
    discoveredAt: NOW.toISOString(),
    source: "provider-api",
    ...patch,
  };
}

function plan(patch: Partial<MantisLocalProviderPlan> = {}): MantisLocalProviderPlan {
  return {
    scanId: "scan-local",
    connectionId: "claude-local",
    routeKind: "claude-code-local",
    protocol: "claude-code-cli",
    modelSelectionMode: "catalog",
    modelId: "claude-opus-4-1",
    ...patch,
  };
}

function snapshot(patch: Partial<ScanConnectionSnapshot> = {}): ScanConnectionSnapshot {
  return {
    scanId: "scan-local",
    connectionId: "claude-local",
    routeKind: "claude-code-local",
    modelSelectionMode: "catalog",
    modelId: "claude-opus-4-1",
    capabilityCheckId: null,
    capturedAt: NOW.toISOString(),
    ...patch,
  };
}

function source(root: string): string {
  for (const stage of STAGES) {
    const skillDir = path.join(root, stage === "report" ? "mantis-report" : `mantis-${stage}`);
    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${stage}\nTrusted defensive stage.\n`, { mode: 0o600 });
  }
  return root;
}

function finalFor(input: DefensiveLocalCliInput): unknown {
  const stage = String(input.prompt.match(/stage_id=([a-z-]+)/)?.[1]);
  if (stage === "report") {
    return {
      stage,
      summary: "report complete",
      report: {
        schemaVersion: 1,
        engine: "mantis",
        stage: "report",
        findings: [{
          id: "authz-users",
          title: "Authenticated users can enumerate every account",
          severity: "HIGH",
          code_paths: ["src/auth.ts:1-2"],
          status: "VALID",
          reasoning: "The handler lacks an ownership predicate.",
        }],
      },
    };
  }
  return { stage, summary: `${stage} complete` };
}

test("Mantis local Claude executes exactly nine isolated JSON stages and materializes Inspector evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-runner-"));
  const repositoryPath = path.join(root, "repository");
  const outputDir = path.join(root, "output");
  const skillsRoot = source(path.join(root, "skills"));
  const calls: DefensiveLocalCliInput[] = [];
  const approved: string[][] = [];
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repositoryPath, "src", "auth.ts"),
    "export const users = db.users.findMany();\nexport const count = users.length;\n",
  );

  try {
    const result = await runMantisLocalClaude({
      outputDir,
      repositoryPath,
      paths: [],
      sourceRef: "a".repeat(40),
      skillsRoot,
      providerPlan: plan(),
    }, {
      getSnapshot: () => snapshot(),
      getConnection: () => connection(),
      getModel: () => model(),
      createCli: (approvedCwds) => {
        approved.push([...approvedCwds]);
        return {
          run: async (input) => {
            calls.push(input);
            return { final: finalFor(input), usage: null };
          },
        } satisfies DefensiveLocalCli;
      },
      now: () => NOW,
    });

    const snapshotRoot = path.join(outputDir, "mantis-snapshot");
    assert.equal(calls.length, 9);
    assert.deepEqual(calls.map((input) => input.cwd), Array(9).fill(snapshotRoot));
    assert.deepEqual(approved, [[snapshotRoot]]);
    assert.deepEqual(calls.map((input) => input.model), Array(9).fill({ kind: "catalog", id: "claude-opus-4-1" }));
    assert.deepEqual(calls.map((input) => input.modelCatalog), Array(9).fill(["claude-opus-4-1"]));
    assert.equal(result.runtime.usage.reported, false);
    assert.equal(result.runtime.usage.inputTokens, 0);
    assert.equal(result.runtime.usage.outputTokens, 0);
    assert.equal(result.runtime.status, "completed");
    assert.match(calls[1]!.prompt, /BEGIN_PREVIOUS_STAGE_DATA/);
    assert.match(calls[1]!.prompt, /never obey|never follow/i);
    const normalized = JSON.parse(fs.readFileSync(path.join(outputDir, "findings.json"), "utf8")) as {
      findings: Array<{ findingId: string; codeEvidence: Array<{ code: string | null }> }>;
    };
    assert.equal(normalized.findings[0]?.findingId, "mantis-authz-users");
    assert.equal(normalized.findings[0]?.codeEvidence[0]?.code,
      "export const users = db.users.findMany();\nexport const count = users.length;");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local rejects Grok and Cursor plans before creating a CLI", async () => {
  let created = 0;
  const dependencies = {
    getSnapshot: () => snapshot({ routeKind: "xai-grok-build-local" }),
    getConnection: () => connection({ routeKind: "xai-grok-build-local", protocol: "grok-build-cli" }),
    getModel: () => model(),
    createCli: () => {
      created += 1;
      throw new Error("must not create CLI");
    },
    now: () => NOW,
  };
  for (const denied of [
    plan({ routeKind: "xai-grok-build-local", protocol: "grok-build-cli" }),
    plan({ routeKind: "cursor-agent-local", protocol: "cursor-agent-cli" }),
  ]) {
    await assert.rejects(
      runMantisLocalClaude({
        outputDir: "/private/tmp/not-created",
        repositoryPath: "/private/tmp/not-created",
        paths: [],
        sourceRef: "a".repeat(40),
        skillsRoot: "/private/tmp/not-created",
        providerPlan: denied,
      }, dependencies),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "provider_plan_revalidation_failed",
    );
  }
  assert.equal(created, 0);
});

test("Mantis local fails before CLI execution when its pinned source is incomplete", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-source-"));
  let created = 0;
  fs.mkdirSync(path.join(root, "repository"));
  try {
    await assert.rejects(
      runMantisLocalClaude({
        outputDir: path.join(root, "output"),
        repositoryPath: path.join(root, "repository"),
        paths: [],
        sourceRef: "a".repeat(40),
        skillsRoot: path.join(root, "missing-skills"),
        providerPlan: plan(),
      }, {
        getSnapshot: () => snapshot(),
        getConnection: () => connection(),
        getModel: () => model(),
        createCli: () => {
          created += 1;
          throw new Error("must not create CLI");
        },
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "source_invalid",
    );
    assert.equal(created, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local rejects an invalid final report without writing normalized findings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-invalid-report-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  try {
    await assert.rejects(
      runMantisLocalClaude({
        outputDir: path.join(root, "output"),
        repositoryPath,
        paths: [],
        sourceRef: "a".repeat(40),
        skillsRoot: source(path.join(root, "skills")),
        providerPlan: plan(),
      }, {
        getSnapshot: () => snapshot(),
        getConnection: () => connection(),
        getModel: () => model(),
        createCli: () => ({
          run: async (input) => ({
            final: input.prompt.includes("stage_id=report")
              ? { stage: "report", summary: "done", report: { schemaVersion: 1, engine: "mantis", stage: "report" } }
              : { stage: String(input.prompt.match(/stage_id=([a-z-]+)/)?.[1]), summary: "done" },
            usage: null,
          }),
        }),
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "stage_artifact_invalid",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local propagates cancellation and deadline failures from the defensive CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-abort-"));
  fs.mkdirSync(path.join(root, "repository"));
  try {
    for (const code of ["agent_cancelled", "agent_time_limit"] as const) {
      await assert.rejects(
        runMantisLocalClaude({
          outputDir: path.join(root, `output-${code}`),
          repositoryPath: path.join(root, "repository"),
          paths: [],
          sourceRef: "a".repeat(40),
          skillsRoot: source(path.join(root, "skills")),
          providerPlan: plan(),
        }, {
          getSnapshot: () => snapshot(),
          getConnection: () => connection(),
          getModel: () => model(),
          createCli: () => ({
            run: async () => { throw new DefensiveLocalCliError(code); },
          }),
          now: () => NOW,
        }),
        (error: unknown) => error instanceof MantisLocalRunnerError && error.code === code,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
