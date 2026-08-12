import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { parseGateArtifact } from "@csb/gate-core";
import type { GateArtifactV2, GateRun, GuardrailRepository } from "@csb/shared";

import type {
  GitHubActionsArtifactMetadata,
  GitHubActionsDispatchMetadata,
  GitHubActionsDispatchUpdate,
  GateRunUpdate,
} from "../gate-store.js";

const ARTIFACT_FILE = "csb-gate-result.json";
const MANIFEST_FILE = "csb-gate-manifest.json";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_ZIP_ENTRIES = 4;

export type ActionsArtifactImportErrorCode =
  | "actions_artifact_digest_invalid"
  | "actions_artifact_identity_invalid"
  | "actions_artifact_manifest_invalid"
  | "actions_artifact_schema_invalid"
  | "actions_artifact_zip_invalid";

export class ActionsArtifactImportError extends Error {
  constructor(readonly code: ActionsArtifactImportErrorCode) {
    super(code);
    this.name = "ActionsArtifactImportError";
  }
}

export interface ActionsArtifactManifest {
  schemaVersion: 1;
  gateId: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  headSha: string;
  artifactSha256: string;
}

export interface ActionsArtifactBundle {
  artifact: GateArtifactV2;
  manifest: ActionsArtifactManifest;
}

export interface ActionsArtifactImporterStore {
  getGateRun(gateId: string): GateRun | null;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  getDispatch(gateId: string): GitHubActionsDispatchMetadata | null;
  getArtifact(id: string): GitHubActionsArtifactMetadata | null;
  finalize(input: {
    artifactId: string;
    artifactStatus: "validated" | "rejected";
    validatedAt: string;
    gateId: string;
    gateUpdates?: GateRunUpdate;
    dispatchUpdates: GitHubActionsDispatchUpdate;
  }): void;
}

export interface ActionsArtifactImporterDependencies {
  store: ActionsArtifactImporterStore;
  writeArtifact(gateId: string, artifact: GateArtifactV2): string;
  now?(): string;
}

export interface ImportActionsArtifactInput {
  artifactId: string;
  gateId: string;
  githubDigest: string;
  archive: Uint8Array;
}

export interface ImportActionsArtifactResult {
  artifact: GateArtifactV2;
  applied: boolean;
  duplicate: boolean;
}

export class ActionsArtifactImporter {
  readonly #store: ActionsArtifactImporterStore;
  readonly #writeArtifact: ActionsArtifactImporterDependencies["writeArtifact"];
  readonly #now: () => string;

  constructor(dependencies: ActionsArtifactImporterDependencies) {
    this.#store = dependencies.store;
    this.#writeArtifact = dependencies.writeArtifact;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  import(input: ImportActionsArtifactInput): ImportActionsArtifactResult {
    const gate = this.#store.getGateRun(input.gateId);
    const dispatch = this.#store.getDispatch(input.gateId);
    const metadata = this.#store.getArtifact(input.artifactId);
    if (gate === null || dispatch === null || metadata === null) {
      throw new ActionsArtifactImportError("actions_artifact_identity_invalid");
    }
    if (
      metadata.gateId !== gate.id
      || metadata.repositoryKey !== gate.repositoryKey
      || metadata.workflowRunId !== dispatch.workflowRunId
      || metadata.workflowRunAttempt !== dispatch.workflowRunAttempt
      || metadata.artifactDigest !== normalizedGitHubDigest(input.githubDigest)
      || metadata.artifactSchemaVersion !== 2
    ) {
      throw new ActionsArtifactImportError("actions_artifact_identity_invalid");
    }
    if (metadata.status === "validated") {
      const bundle = parseActionsArtifactArchive(input.archive, input.githubDigest);
      validateActionsArtifactIdentity(bundle, gate, dispatch, this.#store.getRepository(gate.repositoryKey));
      return { artifact: bundle.artifact, applied: false, duplicate: true };
    }
    if (
      metadata.status !== "pending"
    ) {
      throw new ActionsArtifactImportError("actions_artifact_identity_invalid");
    }

    let bundle: ActionsArtifactBundle;
    try {
      bundle = parseActionsArtifactArchive(input.archive, input.githubDigest);
      validateActionsArtifactIdentity(bundle, gate, dispatch, this.#store.getRepository(gate.repositoryKey));
    } catch (error) {
      const now = this.#now();
      this.#store.finalize({
        artifactId: metadata.id,
        artifactStatus: "rejected",
        validatedAt: now,
        gateId: gate.id,
        dispatchUpdates: {
          state: "failed",
          completedAt: now,
          error: artifactImportCode(error),
        },
      });
      throw error;
    }

    const now = this.#now();
    const terminal = gate.status === "cancelled" || gate.status === "error" || gate.status === "completed";
    let artifactPath: string | null = null;
    if (!terminal) artifactPath = this.#writeArtifact(gate.id, bundle.artifact);
    const estimatedUsd = bundle.artifact.scan.cost?.estimatedUsd ?? 0;
    this.#store.finalize({
      artifactId: metadata.id,
      artifactStatus: "validated",
      validatedAt: now,
      gateId: gate.id,
      ...(terminal ? {} : {
        gateUpdates: {
          artifactPath,
          artifactSchemaVersion: 2,
          scanLineageHash: bundle.artifact.lineage.scanLineageHash,
          baselineCommit: bundle.artifact.baselineCommit,
          outcome: bundle.artifact.decision.outcome,
          status: "completed",
          estimatedUsd,
          error: null,
          completedAt: now,
          publishStatus: bundle.artifact.publication.eligible ? "waiting" : "not_configured",
        },
      }),
      dispatchUpdates: terminal
        ? {
            state: gate.status === "cancelled" ? "cancelled" : gate.status === "completed" ? "completed" : "failed",
            completedAt: dispatch.completedAt ?? now,
          }
        : { state: "completed", completedAt: now, error: null },
    });
    return { artifact: bundle.artifact, applied: !terminal, duplicate: false };
  }
}

export function parseActionsArtifactArchive(
  archive: Uint8Array,
  githubDigest: string,
): ActionsArtifactBundle {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    fail("actions_artifact_zip_invalid");
  }
  const expectedDigest = normalizedGitHubDigest(githubDigest);
  const actualDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (actualDigest !== expectedDigest) fail("actions_artifact_digest_invalid");

  const files = readBoundedZip(archive);
  const artifactBytes = files.get(ARTIFACT_FILE);
  const manifestBytes = files.get(MANIFEST_FILE);
  if (artifactBytes === undefined || manifestBytes === undefined || files.size !== 2) {
    fail("actions_artifact_zip_invalid");
  }
  if (artifactBytes.byteLength > MAX_ARTIFACT_BYTES || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    fail("actions_artifact_zip_invalid");
  }
  const manifest = parseManifest(parseJson(manifestBytes, "actions_artifact_manifest_invalid"));
  const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
  if (artifactHash !== manifest.artifactSha256) fail("actions_artifact_manifest_invalid");
  let parsed;
  try {
    parsed = parseGateArtifact(parseJson(artifactBytes, "actions_artifact_schema_invalid"));
  } catch {
    fail("actions_artifact_schema_invalid");
  }
  if (parsed.schemaVersion !== 2) fail("actions_artifact_schema_invalid");
  return { artifact: parsed, manifest };
}

function validateActionsArtifactIdentity(
  bundle: ActionsArtifactBundle,
  gate: GateRun,
  dispatch: GitHubActionsDispatchMetadata,
  repository: GuardrailRepository | null,
): void {
  const { artifact, manifest } = bundle;
  if (
    repository === null
    || repository.source !== "github"
    || repository.repositoryPath !== null
    || repository.githubRepositoryId !== dispatch.repositoryId
    || dispatch.workflowRunId === null
    || dispatch.workflowRunAttempt === null
    || artifact.gateId !== gate.id
    || artifact.source !== "github"
    || artifact.executor !== "github-actions"
    || artifact.repository.id !== `github:${dispatch.repositoryId}`
    || artifact.repository.key !== gate.repositoryKey
    || artifact.repository.locator.kind !== "github"
    || artifact.repository.locator.repositoryId !== dispatch.repositoryId
    || artifact.repository.locator.owner.toLowerCase() !== (repository.remoteOwner ?? "").toLowerCase()
    || artifact.repository.locator.name.toLowerCase() !== (repository.remoteName ?? "").toLowerCase()
    || artifact.resolvedTarget.baseRef !== gate.baseRef
    || artifact.resolvedTarget.headRef !== gate.headRef
    || artifact.resolvedTarget.baseSha !== gate.resolvedBaseSha
    || artifact.resolvedTarget.headSha !== gate.resolvedHeadSha
    || artifact.resolvedTarget.policySha !== gate.policySha
    || artifact.resolvedTarget.pullRequestNumber !== gate.pullRequestNumber
    || artifact.changeSet.baseSha !== gate.resolvedBaseSha
    || artifact.changeSet.headSha !== gate.resolvedHeadSha
    || artifact.policy.schemaVersion !== gate.policyVersion
    || artifact.workflowRun?.id !== dispatch.workflowRunId
    || artifact.workflowRun.attempt !== dispatch.workflowRunAttempt
    || manifest.gateId !== gate.id
    || manifest.workflowRunId !== dispatch.workflowRunId
    || manifest.workflowRunAttempt !== dispatch.workflowRunAttempt
    || manifest.headSha !== gate.resolvedHeadSha
    || artifact.target.kind !== dispatch.targetKind
  ) {
    fail("actions_artifact_identity_invalid");
  }
  if (
    (artifact.target.kind === "pull_request" && artifact.target.number !== gate.pullRequestNumber)
    || (artifact.target.kind === "compare" && (
      artifact.target.baseRef !== gate.baseRef || artifact.target.headRef !== gate.headRef
    ))
    || (artifact.target.kind === "protected_branch" && artifact.target.ref !== dispatch.protectedBranch)
  ) {
    fail("actions_artifact_identity_invalid");
  }
}

function parseManifest(value: unknown): ActionsArtifactManifest {
  const record = plainRecord(value, "actions_artifact_manifest_invalid");
  const keys = Object.keys(record).sort();
  const expected = [
    "artifactSha256",
    "gateId",
    "headSha",
    "schemaVersion",
    "workflowRunAttempt",
    "workflowRunId",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) fail("actions_artifact_manifest_invalid");
  if (
    record.schemaVersion !== 1
    || typeof record.gateId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record.gateId)
    || typeof record.workflowRunId !== "string"
    || !/^[1-9][0-9]{0,30}$/.test(record.workflowRunId)
    || !Number.isSafeInteger(record.workflowRunAttempt)
    || (record.workflowRunAttempt as number) <= 0
    || typeof record.headSha !== "string"
    || !/^[0-9a-f]{40}$/.test(record.headSha)
    || typeof record.artifactSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(record.artifactSha256)
  ) {
    fail("actions_artifact_manifest_invalid");
  }
  return record as unknown as ActionsArtifactManifest;
}

function readBoundedZip(archive: Uint8Array): Map<string, Uint8Array> {
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    entryCount === 0
    || entryCount > MAX_ZIP_ENTRIES
    || centralOffset + centralSize > eocd
    || bytes.readUInt16LE(eocd + 8) !== entryCount
  ) fail("actions_artifact_zip_invalid");

  const files = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("actions_artifact_zip_invalid");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      (flags & 1) !== 0
      || (method !== 0 && method !== 8)
      || uncompressedSize > MAX_ARTIFACT_BYTES
      || compressedSize > MAX_ARCHIVE_BYTES
      || next > eocd
      || localOffset + 30 > centralOffset
    ) fail("actions_artifact_zip_invalid");
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const name = safeArtifactEntryName(rawName);
    if (files.has(name) || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("actions_artifact_zip_invalid");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) fail("actions_artifact_zip_invalid");
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let output: Buffer;
    try {
      output = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_ARTIFACT_BYTES });
    } catch {
      fail("actions_artifact_zip_invalid");
    }
    if (output.byteLength !== uncompressedSize) fail("actions_artifact_zip_invalid");
    files.set(name, new Uint8Array(output));
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) fail("actions_artifact_zip_invalid");
  return files;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.length) return offset;
    }
  }
  fail("actions_artifact_zip_invalid");
}

function safeArtifactEntryName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (normalized === ARTIFACT_FILE || normalized === MANIFEST_FILE) return normalized;
  if (normalized === `.csb-results/${ARTIFACT_FILE}`) return ARTIFACT_FILE;
  if (normalized === `.csb-results/${MANIFEST_FILE}`) return MANIFEST_FILE;
  fail("actions_artifact_zip_invalid");
}

function normalizedGitHubDigest(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) fail("actions_artifact_digest_invalid");
  return value;
}

function parseJson(bytes: Uint8Array, code: ActionsArtifactImportErrorCode): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
}

function plainRecord(
  value: unknown,
  code: ActionsArtifactImportErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as Record<string, unknown>;
}

function artifactImportCode(error: unknown): ActionsArtifactImportErrorCode {
  return error instanceof ActionsArtifactImportError
    ? error.code
    : "actions_artifact_schema_invalid";
}

function fail(code: ActionsArtifactImportErrorCode): never {
  throw new ActionsArtifactImportError(code);
}
