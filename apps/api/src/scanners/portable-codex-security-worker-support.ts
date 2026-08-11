import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  WORKSPACE_TOOL_NAMES,
  type AgentEvent,
  type AgentSession,
  type AgentSessionErrorCode,
  type AgentUsage,
} from "../agent/session-types.js";
import type { ScannerUsage } from "./usage.js";
import type { PortableCodexSecurityStage } from "./portable-codex-security-profile.js";

export const PORTABLE_CODEX_SECURITY_TOOL_SURFACE = Object.freeze([
  ...WORKSPACE_TOOL_NAMES,
] as const);

const SNAPSHOT_EXCLUDES = new Set([
  ".git", ".hg", ".svn", "node_modules", ".next", ".nuxt", ".turbo",
  "dist", "build", "coverage", ".cache",
]);
const MAX_SNAPSHOT_ENTRIES = 500_000;
const MAX_ARTIFACT_BYTES = 1_048_576;
const MAX_STAGE_SUMMARY_BYTES = 16_384;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;

export type PortableCodexSecurityStageErrorCode =
  | "agent_cancelled"
  | "agent_turn_limit"
  | "agent_tool_limit"
  | "agent_input_byte_limit"
  | "agent_output_byte_limit"
  | "agent_time_limit"
  | "stage_evidence_incomplete"
  | "stage_artifact_invalid"
  | "agent_session_failed"
  | "snapshot_invalid";

export class PortableCodexSecurityStageError extends Error {
  constructor(readonly code: PortableCodexSecurityStageErrorCode) {
    super(code);
    this.name = "PortableCodexSecurityStageError";
  }
}

export interface PortableCodexSecuritySnapshot {
  snapshotRoot: string;
  snapshotId: string;
}

export interface PortableCodexSecurityStageObservationInput {
  session: AgentSession;
  stage: PortableCodexSecurityStage;
  artifactRoot: string;
  usage: ScannerUsage;
  redact: (value: string) => string;
  signal?: AbortSignal;
  onEvent?: (safeEvent: string) => void;
  /** Persists usage as it arrives so a later stage failure cannot erase it. */
  onUsage?: (usage: ScannerUsage) => void;
}

export interface PortableCodexSecurityStageObservation {
  usage: ScannerUsage;
  previousStageStateBase64: string;
}

/**
 * Creates a private source copy which excludes repositories' executable and
 * generated state. The snapshot id is written before every tree entry is made
 * immutable, so later stage checks can detect any mutation.
 */
export function createPortableCodexSecuritySnapshot(
  repositoryPath: string,
  outputDir: string,
): PortableCodexSecuritySnapshot {
  const sourceRoot = path.resolve(repositoryPath);
  const resolvedOutput = path.resolve(outputDir);
  const snapshotRoot = path.join(resolvedOutput, "portable-codex-security-snapshot");
  let sourceInfo: fs.Stats;
  try {
    sourceInfo = fs.lstatSync(sourceRoot);
  } catch {
    throw new PortableCodexSecurityStageError("snapshot_invalid");
  }
  if (
    sourceInfo.isSymbolicLink() ||
    !sourceInfo.isDirectory() ||
    isInside(sourceRoot, resolvedOutput) ||
    fs.existsSync(snapshotRoot)
  ) {
    throw new PortableCodexSecurityStageError("snapshot_invalid");
  }

  let entries = 0;
  try {
    fs.mkdirSync(resolvedOutput, { recursive: true, mode: 0o700 });
    fs.cpSync(sourceRoot, snapshotRoot, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      filter(source) {
        if (source === sourceRoot) return true;
        const relative = path.relative(sourceRoot, source);
        if (relative.split(path.sep).some((segment) => SNAPSHOT_EXCLUDES.has(segment))) {
          return false;
        }
        const info = fs.lstatSync(source);
        if (info.isSymbolicLink()) return false;
        entries += 1;
        if (entries > MAX_SNAPSHOT_ENTRIES) {
          throw new PortableCodexSecurityStageError("snapshot_invalid");
        }
        return true;
      },
    });
    const snapshotId = hashPortableCodexSecuritySnapshot(snapshotRoot);
    fs.writeFileSync(
      path.join(snapshotRoot, ".portable-codex-security-snapshot-id"),
      `${snapshotId}\n`,
      { encoding: "utf8", mode: 0o400 },
    );
    lockReadOnly(snapshotRoot);
    return { snapshotRoot, snapshotId };
  } catch (error) {
    if (error instanceof PortableCodexSecurityStageError) throw error;
    throw new PortableCodexSecurityStageError("snapshot_invalid");
  }
}

export function hashPortableCodexSecuritySnapshot(snapshotRoot: string): string {
  const root = path.resolve(snapshotRoot);
  const rootInfo = fs.lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new PortableCodexSecurityStageError("snapshot_invalid");
  }
  const hash = createHash("sha256");
  const files = listRegularFiles(root);
  for (const file of files) {
    const relative = path.relative(root, file);
    if (relative === ".portable-codex-security-snapshot-id") continue;
    hash.update(relative);
    hash.update("\0");
    hash.update(readPinnedSnapshotFile(file));
    hash.update("\0");
  }
  return `content:${hash.digest("hex")}`;
}

function readPinnedSnapshotFile(file: string): Buffer {
  let descriptor: number | undefined;
  try {
    const expected = fs.lstatSync(file);
    if (expected.isSymbolicLink() || !expected.isFile()) throw new Error("unsafe file");
    descriptor = fs.openSync(file, READ_NO_FOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!sameVersion(expected, opened) || !opened.isFile() || opened.isSymbolicLink()) {
      throw new Error("file changed");
    }
    const output = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < output.length) {
      const read = fs.readSync(descriptor, output, offset, output.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const afterOpen = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(file);
    if (offset !== output.length || afterPath.isSymbolicLink() ||
      !sameVersion(opened, afterOpen) || !sameVersion(opened, afterPath)) {
      throw new Error("file changed");
    }
    return output;
  } catch {
    throw new PortableCodexSecurityStageError("snapshot_invalid");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertPortableCodexSecuritySnapshot(
  snapshot: PortableCodexSecuritySnapshot,
): void {
  try {
    const root = fs.lstatSync(snapshot.snapshotRoot);
    if (root.isSymbolicLink() || !root.isDirectory() || (root.mode & 0o222) !== 0) {
      throw new Error("invalid root");
    }
    const marker = fs.readFileSync(
      path.join(snapshot.snapshotRoot, ".portable-codex-security-snapshot-id"),
      "utf8",
    ).trim();
    if (marker !== snapshot.snapshotId || hashPortableCodexSecuritySnapshot(snapshot.snapshotRoot) !== snapshot.snapshotId) {
      throw new Error("hash mismatch");
    }
  } catch {
    throw new PortableCodexSecurityStageError("snapshot_invalid");
  }
}

/** A stage receives only a clean artifact root and must prove the expected loop. */
export async function observePortableCodexSecurityStage(
  input: PortableCodexSecurityStageObservationInput,
): Promise<PortableCodexSecurityStageObservation> {
  let snapshotToolRequested = false;
  let snapshotToolConsumed = false;
  let resultsWriteRequested = 0;
  let artifactEvents = 0;
  let completion: Record<string, unknown> | null = null;
  let usage = input.usage;
  const iterator = input.session.run()[Symbol.asyncIterator]();

  try {
    for (;;) {
      const next = await nextWithAbort(iterator, input.signal);
      if (next.done) break;
      const event = next.value;
      emitSafeEvent(event, input.redact, input.onEvent);
      switch (event.type) {
        case "tool": {
          if (!PORTABLE_CODEX_SECURITY_TOOL_SURFACE.includes(event.name)) {
            throw new PortableCodexSecurityStageError("stage_evidence_incomplete");
          }
          if (event.name === "results.write") {
            if (event.phase === "requested") resultsWriteRequested += 1;
          } else {
            if (event.phase === "requested") snapshotToolRequested = true;
            if (event.phase === "consumed" && event.ok !== false) snapshotToolConsumed = true;
          }
          break;
        }
        case "artifact":
          if (event.path !== input.stage.artifact || event.bytes <= 0 || artifactEvents > 0) {
            throw new PortableCodexSecurityStageError("stage_artifact_invalid");
          }
          artifactEvents += 1;
          break;
        case "usage":
          usage = addPortableCodexSecurityUsage(usage, event.usage);
          input.onUsage?.(usage);
          break;
        case "completion":
          if (completion !== null || !isStructuredCompletion(event.structured, input.stage)) {
            throw new PortableCodexSecurityStageError("stage_evidence_incomplete");
          }
          completion = event.structured;
          break;
        case "failure":
          throw new PortableCodexSecurityStageError(
            portableAgentFailureCode(event.code),
          );
        case "cancellation":
          throw new PortableCodexSecurityStageError("agent_cancelled");
      }
    }
  } catch (error) {
    if (error instanceof PortableCodexSecurityStageError) throw error;
    throw new PortableCodexSecurityStageError(input.signal?.aborted ? "agent_cancelled" : "agent_session_failed");
  } finally {
    if (input.signal?.aborted) {
      void iterator.return?.().catch(() => undefined);
    }
  }

  if (
    !snapshotToolRequested ||
    !snapshotToolConsumed ||
    resultsWriteRequested !== 1 ||
    artifactEvents !== 1 ||
    completion === null
  ) {
    throw new PortableCodexSecurityStageError("stage_evidence_incomplete");
  }
  assertExactStageArtifact(input.artifactRoot, input.stage);
  const summary = completion.summary;
  const summaryText = typeof summary === "string" && summary.trim().length > 0
    ? summary.trim()
    : null;
  if (summaryText === null || Buffer.byteLength(summaryText, "utf8") > MAX_STAGE_SUMMARY_BYTES) {
    throw new PortableCodexSecurityStageError("stage_evidence_incomplete");
  }
  return {
    usage,
    previousStageStateBase64: Buffer.from(
      JSON.stringify({ stage: input.stage.id, summary: summaryText }),
      "utf8",
    ).toString("base64"),
  };
}

function portableAgentFailureCode(
  code: AgentSessionErrorCode,
): PortableCodexSecurityStageErrorCode {
  switch (code) {
    case "agent_cancelled":
    case "agent_turn_limit":
    case "agent_tool_limit":
    case "agent_input_byte_limit":
    case "agent_output_byte_limit":
    case "agent_time_limit":
      return code;
    default:
      return "agent_session_failed";
  }
}

/** Preserves the unknown-vs-zero distinction by omitting cache-write usage until observed. */
export function addPortableCodexSecurityUsage(
  current: ScannerUsage,
  usage: AgentUsage,
): ScannerUsage {
  const incoming = {
    inputTokens: validTokenCount(usage.inputTokens) ? usage.inputTokens : null,
    cachedInputTokens: validTokenCount(usage.cachedInputTokens) ? usage.cachedInputTokens : null,
    cacheWriteInputTokens: validTokenCount(usage.cacheWriteInputTokens)
      ? usage.cacheWriteInputTokens
      : null,
    outputTokens: validTokenCount(usage.outputTokens) ? usage.outputTokens : null,
  };
  const reported = Object.values(incoming).some((value) => value !== null);
  if (!reported) return current;
  const hadUsage = current.reported === true;
  const knownAfter = (wasKnown: boolean | undefined, isKnown: boolean): boolean =>
    hadUsage ? wasKnown === true && isKnown : isKnown;
  return {
    reported: true,
    inputTokensKnown: knownAfter(current.inputTokensKnown, incoming.inputTokens !== null),
    cachedInputTokensKnown: knownAfter(
      current.cachedInputTokensKnown,
      incoming.cachedInputTokens !== null,
    ),
    cacheWriteInputTokensKnown: knownAfter(
      current.cacheWriteInputTokensKnown,
      incoming.cacheWriteInputTokens !== null,
    ),
    outputTokensKnown: knownAfter(current.outputTokensKnown, incoming.outputTokens !== null),
    ...(incoming.inputTokens === null
      ? {}
      : {
        maximumInputTokensPerRequest: Math.max(
          current.maximumInputTokensPerRequest ?? 0,
          incoming.inputTokens,
        ),
      }),
    inputTokens: current.inputTokens + (incoming.inputTokens ?? 0),
    cachedInputTokens: current.cachedInputTokens + (incoming.cachedInputTokens ?? 0),
    ...(incoming.cacheWriteInputTokens === null && current.cacheWriteInputTokens === undefined
      ? {}
      : {
          cacheWriteInputTokens:
            (current.cacheWriteInputTokens ?? 0) + (incoming.cacheWriteInputTokens ?? 0),
        }),
    outputTokens: current.outputTokens + (incoming.outputTokens ?? 0),
  };
}

export function materializePortableCodexSecurityReportArtifact(
  artifactRoot: string,
  resultsDir: string,
  artifactName: string,
): void {
  assertExactStageArtifact(artifactRoot, { artifact: artifactName } as PortableCodexSecurityStage);
  const source = path.join(artifactRoot, artifactName);
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const target = path.join(resultsDir, artifactName);
  if (fs.existsSync(target)) throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}

function assertExactStageArtifact(artifactRoot: string, stage: Pick<PortableCodexSecurityStage, "artifact">): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(artifactRoot, { withFileTypes: true });
  } catch {
    throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  }
  if (entries.length !== 1 || entries[0]?.name !== stage.artifact || !entries[0].isFile()) {
    throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  }
  const artifact = path.join(artifactRoot, stage.artifact);
  const info = fs.lstatSync(artifact);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
    throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(artifact, "utf8"));
  } catch {
    throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  }
  if (stage.artifact === "sentinel-findings.json") {
    if (parsed.stage !== undefined && parsed.stage !== "report") {
      throw new PortableCodexSecurityStageError("stage_artifact_invalid");
    }
    if (!Array.isArray(parsed.findings)) throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  } else if (parsed.stage !== stageNameForArtifact(stage.artifact)) {
    throw new PortableCodexSecurityStageError("stage_artifact_invalid");
  }
}

function stageNameForArtifact(artifact: string): string {
  if (artifact === "01-inventory.json") return "inventory";
  if (artifact === "02-threat-model.json") return "threat-model";
  if (artifact === "03-discovery.json") return "discovery";
  if (artifact === "04-dataflow.json") return "dataflow";
  if (artifact === "05-validation.json") return "validation";
  return "report";
}

function isStructuredCompletion(
  value: unknown,
  stage: PortableCodexSecurityStage,
): value is Record<string, unknown> {
  return isRecord(value) &&
    value.stage === stage.id &&
    value.artifact === stage.artifact &&
    value.status === "completed" &&
    typeof value.summary === "string";
}

function emitSafeEvent(
  event: AgentEvent,
  redact: (value: string) => string,
  onEvent?: (safeEvent: string) => void,
): void {
  if (onEvent === undefined) return;
  try {
    onEvent(redact(JSON.stringify(event)));
  } catch {
    throw new PortableCodexSecurityStageError("agent_session_failed");
  }
}

function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  if (signal === undefined) return iterator.next();
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      reject(new PortableCodexSecurityStageError("agent_cancelled"));
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    void iterator.next().then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

function lockReadOnly(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new PortableCodexSecurityStageError("snapshot_invalid");
    if (entry.isDirectory()) {
      lockReadOnly(candidate);
      fs.chmodSync(candidate, 0o500);
    } else if (entry.isFile()) {
      fs.chmodSync(candidate, 0o400);
    } else {
      throw new PortableCodexSecurityStageError("snapshot_invalid");
    }
  }
  fs.chmodSync(root, 0o500);
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new PortableCodexSecurityStageError("snapshot_invalid");
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new PortableCodexSecurityStageError("snapshot_invalid");
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
