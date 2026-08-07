import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  buildGateArtifact,
  buildOperationalErrorArtifact,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type { GateArtifact } from "@csb/shared";

import type { GhResult, GhRunner } from "./github-cli.js";
import {
  BaselineUnavailableError,
  GitHubBaselineProvider,
} from "./github-baseline.js";
import { getCachedGitHubBaseline } from "./gate-store.js";

interface RunFixture {
  databaseId: number;
  headSha: string;
  createdAt: string;
  conclusion?: string;
}

function artifact(headSha: string): GateArtifact {
  return buildGateArtifact({
    gateId: `gate-${headSha}`,
    repository: {
      key: "github.com/okami/csb",
      owner: "okami",
      name: "csb",
      defaultBranch: "main",
    },
    source: "github",
    changeSet: {
      baseRef: "base",
      headRef: headSha,
      baseSha: "base123",
      headSha,
      files: [
        {
          status: "modified",
          path: "src/a.ts",
          previousPath: null,
          additions: 1,
          deletions: 0,
        },
      ],
      scanPaths: ["src/a.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy: defaultGuardrailPolicy(),
    scan: { id: `scan-${headSha}`, cost: null, status: "completed" },
    baselineCommit: null,
    evaluation: {
      deltas: [],
      decision: {
        outcome: "bootstrap",
        summary: "Baseline initialized with 0 finding(s).",
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "neutral",
      },
    },
    versions: { gateCore: "0.1.0", scanner: "gpt-5.6-sol" },
    createdAt: "2026-08-07T12:00:00.000Z",
  });
}

function operationalErrorArtifact(headSha: string): GateArtifact {
  const valid = artifact(headSha);
  return buildOperationalErrorArtifact({
    gateId: valid.gateId,
    repository: valid.repository,
    source: valid.source,
    changeSet: valid.changeSet,
    policy: valid.policy,
    scan: valid.scan,
    baselineCommit: valid.baselineCommit,
    versions: valid.versions,
    createdAt: valid.createdAt,
    operationalSummary: "Operational failure",
  });
}

function repositoryContext() {
  return {
    repositoryKey: "github.com/okami/csb",
    owner: "okami",
    name: "csb",
    defaultBranch: "main",
  };
}

function run(
  databaseId: number,
  headSha: string,
  createdAt: string,
  conclusion?: string,
): RunFixture {
  return { databaseId, headSha, createdAt, conclusion };
}

function fakeGh(options: {
  runs: RunFixture[];
  artifacts?: Record<string, unknown>;
  downloadFailures?: ReadonlySet<string>;
}): { runner: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const success = (stdout = ""): GhResult => ({ stdout, stderr: "", exitCode: 0 });
  const failure = (stderr: string): GhResult => ({ stdout: "", stderr, exitCode: 1 });

  return {
    calls,
    runner: async (args) => {
      calls.push(args);
      if (args[0] === "run" && args[1] === "list") {
        return success(JSON.stringify(options.runs));
      }
      if (args[0] === "run" && args[1] === "download") {
        const workflowRunId = args[2]!;
        if (options.downloadFailures?.has(workflowRunId)) {
          return failure("artifact expired");
        }
        const directory = args[args.indexOf("--dir") + 1]!;
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "csb-gate-result.json"),
          JSON.stringify(options.artifacts?.[workflowRunId] ?? artifact(workflowRunId)),
        );
        return success();
      }
      return failure(`unexpected gh call: ${args.join(" ")}`);
    },
  };
}

function cacheFixture(): { cacheRoot: string; database: Database.Database } {
  return {
    cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), "csb-github-cache-")),
    database: new Database(":memory:"),
  };
}

function closeFixture(fixture: ReturnType<typeof cacheFixture>): void {
  fixture.database.close();
  fs.rmSync(fixture.cacheRoot, { recursive: true, force: true });
}

test("downloads the newest eligible default-branch artifact", async () => {
  const fixture = cacheFixture();
  const gh = fakeGh({
    runs: [
      run(200, "new", "2026-08-07T12:00:00Z"),
      run(100, "old", "2026-08-07T11:00:00Z"),
    ],
    artifacts: { "200": artifact("new"), "100": artifact("old") },
  });

  try {
    const provider = new GitHubBaselineProvider(
      gh.runner,
      fixture.cacheRoot,
      fixture.database,
    );
    const baseline = await provider.getBaseline(repositoryContext());

    assert.equal(baseline?.changeSet.headSha, "new");
    assert.equal(
      gh.calls.filter((args) => args[0] === "run" && args[1] === "download")
        .length,
      1,
    );
    const cached = getCachedGitHubBaseline(
      repositoryContext().repositoryKey,
      fixture.database,
    );
    assert.equal(cached?.workflowRunId, "200");
    assert.equal(cached?.artifactPath.startsWith(fixture.cacheRoot), true);
  } finally {
    closeFixture(fixture);
  }
});

test("rejects an artifact with a future schema", async () => {
  const fixture = cacheFixture();
  const future = {
    ...artifact("new"),
    schemaVersion: 2,
  };
  const gh = fakeGh({
    runs: [run(200, "new", "2026-08-07T12:00:00Z")],
    artifacts: { "200": future },
  });

  try {
    const provider = new GitHubBaselineProvider(
      gh.runner,
      fixture.cacheRoot,
      fixture.database,
    );
    await assert.rejects(
      () => provider.getBaseline(repositoryContext()),
      /GateArtifact schema 2 não suportado/,
    );
  } finally {
    closeFixture(fixture);
  }
});

test("returns null when no default-branch artifact exists", async () => {
  const fixture = cacheFixture();
  const gh = fakeGh({ runs: [] });

  try {
    const provider = new GitHubBaselineProvider(
      gh.runner,
      fixture.cacheRoot,
      fixture.database,
    );
    assert.equal(await provider.getBaseline(repositoryContext()), null);
  } finally {
    closeFixture(fixture);
  }
});

test("does not bootstrap when github returns malformed run history", async () => {
  const fixture = cacheFixture();
  const runner: GhRunner = async () => ({
    stdout: JSON.stringify([{ databaseId: null, headSha: "", createdAt: null }]),
    stderr: "",
    exitCode: 0,
  });

  try {
    const provider = new GitHubBaselineProvider(
      runner,
      fixture.cacheRoot,
      fixture.database,
    );
    await assert.rejects(
      () => provider.getBaseline(repositoryContext()),
      (error: unknown) => error instanceof BaselineUnavailableError,
    );
  } finally {
    closeFixture(fixture);
  }
});

test("returns an operational error when run history exists but its artifacts are unavailable", async () => {
  const fixture = cacheFixture();
  const gh = fakeGh({
    runs: [run(200, "new", "2026-08-07T12:00:00Z")],
    downloadFailures: new Set(["200"]),
  });

  try {
    const provider = new GitHubBaselineProvider(
      gh.runner,
      fixture.cacheRoot,
      fixture.database,
    );
    await assert.rejects(
      () => provider.getBaseline(repositoryContext()),
      (error: unknown) =>
        error instanceof BaselineUnavailableError &&
        /histórico encontrado, mas o artifact de baseline não está disponível/.test(
          error.message,
        ),
    );
  } finally {
    closeFixture(fixture);
  }
});

test("skips cancelled and error artifacts before selecting an older valid baseline", async () => {
  const fixture = cacheFixture();
  const gh = fakeGh({
    runs: [
      run(300, "cancelled", "2026-08-07T13:00:00Z", "cancelled"),
      run(200, "error", "2026-08-07T12:00:00Z"),
      run(100, "old", "2026-08-07T11:00:00Z"),
    ],
    artifacts: {
      "200": operationalErrorArtifact("error"),
      "100": artifact("old"),
    },
  });

  try {
    const provider = new GitHubBaselineProvider(
      gh.runner,
      fixture.cacheRoot,
      fixture.database,
    );
    const baseline = await provider.getBaseline(repositoryContext());

    assert.equal(baseline?.changeSet.headSha, "old");
    assert.equal(
      gh.calls.some(
        (args) => args[0] === "run" && args[1] === "download" && args[2] === "300",
      ),
      false,
    );
  } finally {
    closeFixture(fixture);
  }
});
