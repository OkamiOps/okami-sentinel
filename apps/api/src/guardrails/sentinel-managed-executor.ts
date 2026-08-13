import { createHash } from "node:crypto";

import {
  buildGateArtifactV2,
  buildOperationalErrorArtifactV2,
  buildScanLineage,
  classifyGateFindings,
  evaluateGate,
  parseGateArtifact,
  selectGateBaseline,
  type GateBaselineCandidate,
  type GateBaselineSelection,
} from "@csb/gate-core";
import type {
  ChangeSet,
  EffectiveScanLineage,
  FindingSummary,
  FindingTriage,
  GateArtifactV2,
  GateCoverageEnvelope,
  GateFindingDelta,
  GuardrailRepository,
  ScanRun,
  StartScanRequest,
} from "@csb/shared";

import type { StartScanOptions } from "../runner.js";
import { resolveSnapshotChangeSet } from "./snapshot-changeset.js";
import type {
  MaterializationHandle,
  SnapshotMaterializer,
} from "./snapshot-materializer.js";
import type { AcceptedGateTargetPreview } from "./target-preview.js";

const GATE_CORE_VERSION = "0.2.0";
const MATERIALIZER_VERSION = "github-archive-v1";

export type SentinelManagedExecutorErrorCode =
  | "managed_cancelled"
  | "managed_executor_invalid"
  | "managed_scan_failed";

export class SentinelManagedExecutorError extends Error {
  constructor(readonly code: SentinelManagedExecutorErrorCode) {
    super(code);
    this.name = "SentinelManagedExecutorError";
  }
}

export interface SentinelManagedExecutionInput {
  gateId: string;
  repository: GuardrailRepository;
  preview: AcceptedGateTargetPreview;
  signal?: AbortSignal;
  hooks: {
    materialized(identity: string): Promise<void> | void;
    scanStarted(scan: ScanRun): Promise<void> | void;
    finalize(result: SentinelManagedExecutionResult): Promise<void>;
  };
}

export interface SentinelManagedExecutionResult {
  artifact: GateArtifactV2;
  changeSet: ChangeSet;
  scan: ScanRun | null;
  baseline: GateBaselineSelection;
}

export interface SentinelManagedExecutorDependencies {
  materializer: Pick<SnapshotMaterializer, "materialize">;
  startScan(request: StartScanRequest, options: StartScanOptions): Promise<ScanRun>;
  waitForScan(scanId: string): Promise<ScanRun>;
  readFindings(scanDir: string): FindingSummary[];
  readTriage(repositoryKey: string): ReadonlyMap<string, FindingTriage>;
  baselineCandidate(input: {
    repository: GuardrailRepository;
    protectedBranch: string | null;
    lineage: EffectiveScanLineage;
    coverage: GateCoverageEnvelope;
  }): Promise<GateBaselineCandidate>;
  now?(): string;
}

export class SentinelManagedExecutor {
  readonly #now: () => string;

  constructor(readonly dependencies: SentinelManagedExecutorDependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(input: SentinelManagedExecutionInput): Promise<SentinelManagedExecutionResult> {
    validateInput(input);
    throwIfCancelled(input.signal);
    let materialization: MaterializationHandle | null = null;
    try {
      materialization = await this.dependencies.materializer.materialize({
        gateId: input.gateId,
        repository: input.repository,
        baseSha: input.preview.resolvedTarget.baseSha,
        headSha: input.preview.resolvedTarget.headSha,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      throwIfCancelled(input.signal);
      await input.hooks.materialized(materialization.identity);

      const changeSet = resolveSnapshotChangeSet({
        base: materialization.base,
        head: materialization.head,
        target: input.preview.resolvedTarget,
        policy: input.preview.policy,
      });
      const coverage = snapshotCoverage(materialization.head);
      let scan: ScanRun | null = null;
      const establishesProtectedBaseline = input.preview.target.kind === "protected_branch";
      if (changeSet.files.length > 0 || establishesProtectedBaseline) {
        const request = scanRequest(input, changeSet);
        scan = await this.dependencies.startScan(request, {
          executionPath: materialization.head.path,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        await input.hooks.scanStarted(scan);
        scan = await this.dependencies.waitForScan(scan.id);
        throwIfCancelled(input.signal);
      }

      const lineage = scanLineage(scan, input.preview, materialization.head.identity);
      const baselineCandidate = changeSet.files.length === 0 && !establishesProtectedBaseline
        ? { kind: "absent" } as const
        : establishesProtectedBaseline
          ? { kind: "absent" } as const
        : await this.dependencies.baselineCandidate({
            repository: input.repository,
            protectedBranch: input.preview.publication.protectedBranch,
            lineage,
            coverage,
          });
      const baseline = selectGateBaseline({
        repositoryId: repositoryIdentity(input.repository),
        protectedBranch: input.preview.publication.protectedBranch,
        lineage,
        policySchemaVersion: input.preview.policy.schemaVersion,
        coverage,
      }, baselineCandidate);
      const artifact = this.#artifact({
        input,
        materialization,
        changeSet,
        coverage,
        lineage,
        baseline,
        scan,
      });
      const parsed = parseGateArtifact(artifact);
      if (parsed.schemaVersion !== 2) {
        throw new SentinelManagedExecutorError("managed_executor_invalid");
      }
      const result: SentinelManagedExecutionResult = {
        artifact: parsed,
        changeSet,
        scan,
        baseline,
      };
      await input.hooks.finalize(result);
      return result;
    } finally {
      if (materialization !== null) await materialization.release();
    }
  }

  #artifact(context: {
    input: SentinelManagedExecutionInput;
    materialization: MaterializationHandle;
    changeSet: ChangeSet;
    coverage: GateCoverageEnvelope;
    lineage: EffectiveScanLineage;
    baseline: GateBaselineSelection;
    scan: ScanRun | null;
  }): GateArtifactV2 {
    const envelope = artifactEnvelope(context, this.#now());
    if (context.scan !== null && context.scan.status !== "completed") {
      return buildOperationalErrorArtifactV2({
        ...envelope,
        operationalSummary: `scanner_${safeStatus(context.scan.status)}`,
      });
    }
    if (context.coverage.status !== "complete") {
      return buildOperationalErrorArtifactV2({
        ...envelope,
        operationalSummary: "coverage_incomplete",
      });
    }
    if (context.baseline.kind === "unavailable") {
      return buildOperationalErrorArtifactV2({
        ...envelope,
        operationalSummary: `baseline_unavailable:${context.baseline.reason}`,
      });
    }
    if (context.baseline.kind === "incompatible") {
      return buildOperationalErrorArtifactV2({
        ...envelope,
        operationalSummary: `baseline_incompatible:${context.baseline.reason}`,
      });
    }

    const currentFindings = context.scan === null
      ? []
      : this.dependencies.readFindings(context.scan.scanDir);
    const comparable = context.baseline.kind === "comparable"
      ? {
          kind: "comparable" as const,
          findings: context.baseline.artifact.findings
            .filter((finding) => finding.lifecycle !== "fixed")
            .map(findingSummary),
          scanId: context.baseline.artifact.scan.id ?? context.baseline.artifact.gateId,
        }
      : { kind: "absent" as const };
    const evaluationInput = {
      policy: context.input.preview.policy,
      branch: context.changeSet.headRef,
      changeSet: context.changeSet,
      currentFindings,
      baselineFindings: null,
      baseline: comparable,
      historicalFindings: [],
      triageByIdentity: this.dependencies.readTriage(context.input.repository.repositoryKey),
      exceptions: context.input.preview.exceptions,
      sourceScanId: context.scan?.id ?? "no-scan",
      baselineScanId: comparable.kind === "comparable" ? comparable.scanId : null,
      now: this.#now(),
    };
    const evaluation = context.input.preview.target.kind === "protected_branch"
      ? {
          deltas: classifyGateFindings(evaluationInput),
          decision: {
            outcome: "bootstrap" as const,
            summary: `Protected baseline initialized with ${currentFindings.length} finding(s).`,
            violations: [],
            warnings: [],
            exceptionsApplied: [],
            githubConclusion: "neutral" as const,
          },
        }
      : evaluateGate(evaluationInput);
    return buildGateArtifactV2({ ...envelope, evaluation });
  }
}

function artifactEnvelope(
  context: {
    input: SentinelManagedExecutionInput;
    materialization: MaterializationHandle;
    changeSet: ChangeSet;
    coverage: GateCoverageEnvelope;
    lineage: EffectiveScanLineage;
    baseline: GateBaselineSelection;
    scan: ScanRun | null;
  },
  createdAt: string,
) {
  const repository = context.input.repository;
  const repositoryId = requiredRemoteField(repository.githubRepositoryId);
  const owner = requiredRemoteField(repository.remoteOwner);
  const name = requiredRemoteField(repository.remoteName);
  return {
    gateId: context.input.gateId,
    repository: {
      id: repositoryIdentity(repository),
      key: repositoryIdentity(repository),
      owner,
      name,
      defaultBranch: repository.defaultBranch,
      locator: { kind: "github" as const, repositoryId, owner, name },
    },
    source: "github" as const,
    executor: "sentinel-managed" as const,
    target: context.input.preview.target,
    resolvedTarget: context.input.preview.resolvedTarget,
    policySource: context.input.preview.policySource,
    changeSet: context.changeSet,
    policy: context.input.preview.policy,
    scan: {
      id: context.scan?.id ?? null,
      cost: context.scan?.cost ?? null,
      status: context.scan?.status ?? "not_run",
    },
    baselineCommit: context.baseline.kind === "comparable"
      ? context.baseline.artifact.changeSet.headSha
      : null,
    lineage: context.lineage,
    coverage: context.coverage,
    snapshot: {
      identity: context.materialization.identity,
      materializerVersion: MATERIALIZER_VERSION,
    },
    workflowRun: null,
    versions: {
      gateCore: GATE_CORE_VERSION,
      scanner: context.scan?.scannerVersion ?? null,
    },
    createdAt,
  };
}

function scanRequest(
  input: SentinelManagedExecutionInput,
  changeSet: ChangeSet,
): StartScanRequest {
  const repositoryId = requiredRemoteField(input.repository.githubRepositoryId);
  const selected = input.preview.scanSelection ?? null;
  return {
    repositoryPath: `github:${repositoryId}@${input.preview.resolvedTarget.headSha}`,
    displayName: input.repository.displayName,
    engine: selected?.engine ?? "codex-security",
    ...(selected === null ? {} : { connection: selected.connection }),
    ...(selected?.engine === "codex-security" ? { executionProfilePreference: "auto" as const } : {}),
    remoteRepositoryConfirmed: true,
    ...(selected === null ? { model: input.preview.policy.scan.model, effort: input.preview.policy.scan.effort } : {}),
    ...(selected?.effort === undefined ? {} : { effort: selected.effort }),
    mode: selected?.mode ?? input.preview.policy.scan.mode,
    ...(input.preview.costBudget.maxCostUsd === null ? {} : { maxCostUsd: input.preview.costBudget.maxCostUsd }),
    paths: changeSet.scopeMode === "changed" ? changeSet.scanPaths : [],
  };
}

function scanLineage(
  scan: ScanRun | null,
  preview: AcceptedGateTargetPreview,
  headSnapshotIdentity: string,
): EffectiveScanLineage {
  if (scan === null) {
    const selected = preview.scanSelection ?? null;
    return buildScanLineage({
      engine: selected?.engine ?? "codex-security",
      engineVersion: "not-run-v1",
      route: "not-run",
      protocol: "not-run",
      provider: "not-run",
      model: selected === null
        ? preview.policy.scan.model
        : selected.connection.modelId ?? "provider-managed",
      reasoningEffort: selected?.effort ?? "provider-managed",
      methodology: "security-change-gate",
      profile: selected?.mode ?? preview.policy.scan.mode,
      recipeHash: hash({ scan: selected ?? preview.policy.scan, reason: "no_changes" }),
      sourceRevision: hash({ implementation: "sentinel-managed", version: GATE_CORE_VERSION }),
    });
  }
  const unknown = `unreported-${safeIdentifier(scan.id)}`;
  const engineVersion = scan.scannerVersion ?? unknown;
  return buildScanLineage({
    engine: scan.engine,
    engineVersion,
    route: scan.connection?.routeKind ?? scan.execution?.executionProfile ?? unknown,
    protocol: scan.connection?.protocol ?? unknown,
    provider: scan.provider ?? unknown,
    model: scan.model ?? unknown,
    reasoningEffort: scan.effort ?? "provider-managed",
    methodology: scan.execution?.methodologyRef ?? unknown,
    profile: scan.execution?.profileVersion ?? scan.mode ?? unknown,
    recipeHash: canonicalHash(scan.recipeHash) ?? hash({
      scanId: scan.id,
      engine: scan.engine,
      engineVersion,
      model: scan.model,
      headSnapshotIdentity,
    }),
    sourceRevision: hash({ engine: scan.engine, engineVersion }),
  });
}

function snapshotCoverage(snapshot: MaterializationHandle["head"]): GateCoverageEnvelope {
  const partial = snapshot.submodules.length > 0 || snapshot.lfsPointers.length > 0;
  return {
    status: partial ? "partial" : "complete",
    repositoryFileCount: snapshot.fileCount,
    inspectedFileCount: snapshot.fileCount,
    unexaminedFileCount: 0,
    submodules: [...snapshot.submodules],
    lfsPointers: [...snapshot.lfsPointers],
  };
}

function findingSummary(finding: GateFindingDelta): FindingSummary {
  return {
    findingId: finding.findingId,
    occurrenceId: finding.occurrenceId,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    ruleId: finding.ruleId,
    summary: finding.summary,
    primaryPath: finding.primaryPath,
    fingerprints: [...finding.fingerprints],
    category: finding.category,
    cwe: [...finding.cwe],
  };
}

function validateInput(input: SentinelManagedExecutionInput): void {
  const repository = input.repository;
  if (
    repository.source !== "github"
    || repository.repositoryPath !== null
    || input.preview.executor !== "sentinel-managed"
    || input.preview.repositoryKey !== repository.repositoryKey
    || input.preview.repositoryAuthority.connectionId !== repository.githubConnectionId
    || input.preview.repositoryAuthority.installationId !== repository.githubInstallationId
    || input.preview.repositoryAuthority.repositoryId !== repository.githubRepositoryId
  ) {
    throw new SentinelManagedExecutorError("managed_executor_invalid");
  }
}

function repositoryIdentity(repository: GuardrailRepository): string {
  return `github:${requiredRemoteField(repository.githubRepositoryId)}`;
}

function requiredRemoteField(value: string | null): string {
  if (value === null || value.length === 0 || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SentinelManagedExecutorError("managed_executor_invalid");
  }
  return value;
}

function canonicalHash(value: string | null): string | null {
  if (value === null) return null;
  if (/^sha256:[0-9a-f]{64}$/.test(value)) return value;
  if (/^[0-9a-f]{64}$/.test(value)) return `sha256:${value}`;
  return null;
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 120) || "scan";
}

function safeStatus(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64) || "failed";
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SentinelManagedExecutorError("managed_cancelled");
}
