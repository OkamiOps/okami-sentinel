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
const SOURCE_REF = "a".repeat(40);

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

function source(
  root: string,
  sizes: Partial<Record<(typeof STAGES)[number], number>> = {},
): { sourceCacheDir: string; skillsRoot: string } {
  const sourceCacheDir = path.join(root, "mantis-cache");
  const skillsRoot = path.join(sourceCacheDir, SOURCE_REF.slice(0, 12));
  for (const stage of STAGES) {
    const skillDir = path.join(skillsRoot, stage === "report" ? "mantis-report" : `mantis-${stage}`);
    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    const content = `# ${stage}\n${"T".repeat(Math.max(0, (sizes[stage] ?? 32) - stage.length - 4))}\n`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, { mode: 0o600 });
  }
  return { sourceCacheDir, skillsRoot };
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

function removeFixture(root: string): void {
  const unlock = (candidate: string) => {
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      const child = path.join(candidate, entry.name);
      if (entry.isDirectory()) {
        unlock(child);
        fs.chmodSync(child, 0o700);
      } else {
        fs.chmodSync(child, 0o600);
      }
    }
  };
  unlock(root);
  fs.chmodSync(root, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
}

test("Mantis local Claude executes exactly nine isolated JSON stages and materializes Inspector evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-runner-"));
  const repositoryPath = path.join(root, "repository");
  const outputDir = path.join(root, "output");
  const pinnedSource = source(root);
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
      sourceRef: SOURCE_REF,
      ...pinnedSource,
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
      readSourceRevision: () => SOURCE_REF,
      now: () => NOW,
    });

    const snapshotRoot = path.join(outputDir, "mantis-snapshot");
    assert.equal(fs.statSync(snapshotRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(snapshotRoot, "src")).mode & 0o777, 0o500);
    assert.equal(fs.statSync(path.join(snapshotRoot, "src", "auth.ts")).mode & 0o777, 0o400);
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
    removeFixture(root);
  }
});

test("Mantis local accepts a 41,402-byte pinned Mantis skill while every CLI prompt stays bounded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-large-skill-"));
  const repositoryPath = path.join(root, "repository");
  const pinnedSource = source(root, { calibrate: 41_402 });
  const calls: DefensiveLocalCliInput[] = [];
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repositoryPath, "app.ts"), "export const safe = true;\n");
  fs.writeFileSync(path.join(repositoryPath, "src", "auth.ts"), "export const users = db.users.findMany();\nexport const count = users.length;\n");
  assert.equal(fs.statSync(path.join(pinnedSource.skillsRoot, "mantis-calibrate", "SKILL.md")).size, 41_402);

  try {
    await runMantisLocalClaude({
      outputDir: path.join(root, "output"),
      repositoryPath,
      paths: [],
      sourceRef: SOURCE_REF,
      ...pinnedSource,
      providerPlan: plan(),
    }, {
      getSnapshot: () => snapshot(),
      getConnection: () => connection(),
      getModel: () => model(),
      createCli: () => ({
        run: async (input) => {
          calls.push(input);
          return { final: finalFor(input), usage: null };
        },
      }),
      readSourceRevision: () => SOURCE_REF,
      now: () => NOW,
    });

    assert.equal(calls.length, 9);
    assert.ok(calls.every((input) => Buffer.byteLength(input.prompt, "utf8") <= 131_072));
    assert.match(calls.find((input) => input.prompt.includes("stage_id=calibrate"))!.prompt, /T{100}/);
  } finally {
    removeFixture(root);
  }
});

test("Mantis local rejects an oversized final prompt before invoking Claude", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-prompt-cap-"));
  const repositoryPath = path.join(root, "repository");
  const pinnedSource = source(root, { architecture: 64 * 1024 });
  const paths = Array.from({ length: 64 }, (_, index) =>
    `${"p".repeat(1_019)}${String(index).padStart(4, "0")}`,
  );
  let calls = 0;
  fs.mkdirSync(repositoryPath);
  try {
    await assert.rejects(
      runMantisLocalClaude({
        outputDir: path.join(root, "output"),
        repositoryPath,
        paths,
        sourceRef: SOURCE_REF,
        ...pinnedSource,
        providerPlan: plan(),
      }, {
        getSnapshot: () => snapshot(),
        getConnection: () => connection(),
        getModel: () => model(),
        createCli: () => ({
          run: async () => {
            calls += 1;
            return { final: { stage: "architecture", summary: "must not run" }, usage: null };
          },
        }),
        readSourceRevision: () => SOURCE_REF,
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "source_invalid",
    );
    assert.equal(calls, 0);
  } finally {
    removeFixture(root);
  }
});

test("Mantis local detects a snapshot mutation before the next Claude stage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-snapshot-mutation-"));
  const repositoryPath = path.join(root, "repository");
  const pinnedSource = source(root);
  let calls = 0;
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repositoryPath, "src", "auth.ts"), "export const safe = true;\n");
  try {
    await assert.rejects(
      runMantisLocalClaude({
        outputDir: path.join(root, "output"),
        repositoryPath,
        paths: [],
        sourceRef: SOURCE_REF,
        ...pinnedSource,
        providerPlan: plan(),
      }, {
        getSnapshot: () => snapshot(),
        getConnection: () => connection(),
        getModel: () => model(),
        createCli: () => ({
          run: async (input) => {
            calls += 1;
            if (calls === 1) {
              const target = path.join(input.cwd, "src", "auth.ts");
              fs.chmodSync(target, 0o600);
              fs.writeFileSync(target, "export const changed = true;\n");
            }
            return { final: finalFor(input), usage: null };
          },
        }),
        readSourceRevision: () => SOURCE_REF,
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "snapshot_invalid",
    );
    assert.equal(calls, 1);
  } finally {
    removeFixture(root);
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
    readSourceRevision: () => SOURCE_REF,
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
        sourceRef: SOURCE_REF,
        sourceCacheDir: "/private/tmp/not-created-cache",
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
        sourceRef: SOURCE_REF,
        sourceCacheDir: path.join(root, "mantis-cache"),
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
        readSourceRevision: () => SOURCE_REF,
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "source_invalid",
    );
    assert.equal(created, 0);
  } finally {
    removeFixture(root);
  }
});

test("Mantis local rejects a checkout whose resolved Git revision differs from sourceRef", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-local-source-pin-"));
  const repositoryPath = path.join(root, "repository");
  const pinnedSource = source(root);
  let created = 0;
  fs.mkdirSync(repositoryPath);
  try {
    await assert.rejects(
      runMantisLocalClaude({
        outputDir: path.join(root, "output"),
        repositoryPath,
        paths: [],
        sourceRef: SOURCE_REF,
        ...pinnedSource,
        providerPlan: plan(),
      }, {
        getSnapshot: () => snapshot(),
        getConnection: () => connection(),
        getModel: () => model(),
        createCli: () => {
          created += 1;
          throw new Error("must not create CLI");
        },
        readSourceRevision: () => "b".repeat(40),
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "source_invalid",
    );
    assert.equal(created, 0);
  } finally {
    removeFixture(root);
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
        sourceRef: SOURCE_REF,
        ...source(root),
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
        readSourceRevision: () => SOURCE_REF,
        now: () => NOW,
      }),
      (error: unknown) => error instanceof MantisLocalRunnerError && error.code === "stage_artifact_invalid",
    );
  } finally {
    removeFixture(root);
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
          sourceRef: SOURCE_REF,
          ...source(root),
          providerPlan: plan(),
        }, {
          getSnapshot: () => snapshot(),
          getConnection: () => connection(),
          getModel: () => model(),
          createCli: () => ({
            run: async () => { throw new DefensiveLocalCliError(code); },
          }),
          readSourceRevision: () => SOURCE_REF,
          now: () => NOW,
        }),
        (error: unknown) => error instanceof MantisLocalRunnerError && error.code === code,
      );
    }
  } finally {
    removeFixture(root);
  }
});
