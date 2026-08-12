export type GateCliTargetKind = "compare" | "protected_branch" | "pull_request";
export type GateCliBaselineState = "absent" | "available" | "unavailable";

export interface RunGateCliOptions {
  /** Exact head checkout. This is the only root exposed to the scanner. */
  repository: string;
  /** Separate checkout pinned to policySha. */
  policyRoot: string;
  policy: string;
  exceptions: string;
  output: string;
  repositoryId: string;
  repositoryKey: string;
  repositoryName: string;
  defaultBranch: string;
  owner: string;
  executor: "github-actions";
  targetKind: GateCliTargetKind;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  policySha: string;
  protectedBranch: string;
  baseline: string | null;
  baselineState: GateCliBaselineState;
  baselineReason: string | null;
  gateId: string;
  pullRequest: number | null;
  workflowRunId: string;
  workflowRunAttempt: number;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const requiredFlags = [
  "repository",
  "policy-root",
  "policy",
  "exceptions",
  "output",
  "repository-id",
  "repository-key",
  "repository-name",
  "default-branch",
  "owner",
  "executor",
  "target-kind",
  "base-ref",
  "head-ref",
  "base-sha",
  "head-sha",
  "policy-sha",
  "protected-branch",
  "baseline-state",
  "gate-id",
  "workflow-run-id",
  "workflow-run-attempt",
] as const;
const optionalFlags = ["baseline", "baseline-reason", "pull-request"] as const;
const allowedFlags = new Set<string>([...requiredFlags, ...optionalFlags]);
const commitSha = /^[0-9a-f]{40}$/;
const repositoryIdPattern = /^[1-9][0-9]*$/;
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const safeSlug = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function parseArgs(argv: readonly string[]): RunGateCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new CliArgumentError(`Unknown argument at position ${index + 1}`);
    const flag = token.slice(2);
    if (!allowedFlags.has(flag)) throw new CliArgumentError(`Unknown flag --${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw new CliArgumentError(`Missing value for --${flag}`);
    }
    if (values.has(flag)) throw new CliArgumentError(`Duplicate flag --${flag}`);
    values.set(flag, value);
  }

  for (const flag of requiredFlags) {
    if (!values.has(flag)) throw new CliArgumentError(`Missing required flag --${flag}`);
  }

  const repositoryId = required(values, "repository-id");
  if (!repositoryIdPattern.test(repositoryId)) {
    throw new CliArgumentError("--repository-id must be a positive GitHub repository id");
  }
  const repositoryKey = required(values, "repository-key");
  if (repositoryKey !== `github:${repositoryId}`) {
    throw new CliArgumentError("--repository-key must match --repository-id");
  }
  const executor = required(values, "executor");
  if (executor !== "github-actions") {
    throw new CliArgumentError("--executor must equal github-actions");
  }
  const targetKind = required(values, "target-kind");
  if (!isTargetKind(targetKind)) throw new CliArgumentError("--target-kind is invalid");
  const baseSha = fullSha(values, "base-sha");
  const headSha = fullSha(values, "head-sha");
  const policySha = fullSha(values, "policy-sha");
  if (policySha !== baseSha) {
    throw new CliArgumentError("--policy-sha must match the frozen base checkout");
  }
  const baseRef = humanRef(values, "base-ref");
  const headRef = humanRef(values, "head-ref");
  const protectedBranch = humanRef(values, "protected-branch");
  const defaultBranch = humanRef(values, "default-branch");
  const owner = slug(values, "owner");
  const repositoryName = slug(values, "repository-name");
  const gateId = identifier(values, "gate-id");
  const workflowRunId = numericIdentifier(values, "workflow-run-id");
  const workflowRunAttempt = positiveInteger(values, "workflow-run-attempt");
  const pullRequest = optionalPositiveInteger(values, "pull-request");
  if (targetKind === "pull_request" && pullRequest === null) {
    throw new CliArgumentError("--pull-request is required for pull_request targets");
  }
  if (targetKind !== "pull_request" && pullRequest !== null) {
    throw new CliArgumentError("--pull-request is only valid for pull_request targets");
  }
  if (targetKind === "protected_branch" && (
    baseRef !== protectedBranch
    || headRef !== protectedBranch
    || baseSha !== headSha
    || policySha !== headSha
  )) {
    throw new CliArgumentError("protected_branch target identity must describe one frozen revision");
  }

  const baselineState = required(values, "baseline-state");
  if (!isBaselineState(baselineState)) throw new CliArgumentError("--baseline-state is invalid");
  const baseline = values.get("baseline") ?? null;
  const baselineReason = values.get("baseline-reason") ?? null;
  if (baselineState === "available" && baseline === null) {
    throw new CliArgumentError("--baseline is required when --baseline-state=available");
  }
  if (baselineState !== "available" && baseline !== null) {
    throw new CliArgumentError("--baseline is only valid when --baseline-state=available");
  }
  if (baselineState === "unavailable" && baselineReason === null) {
    throw new CliArgumentError("--baseline-reason is required when --baseline-state=unavailable");
  }
  if (baselineState !== "unavailable" && baselineReason !== null) {
    throw new CliArgumentError("--baseline-reason is only valid when --baseline-state=unavailable");
  }

  return {
    repository: required(values, "repository"),
    policyRoot: required(values, "policy-root"),
    policy: relativePath(values, "policy"),
    exceptions: relativePath(values, "exceptions"),
    output: required(values, "output"),
    repositoryId,
    repositoryKey,
    repositoryName,
    defaultBranch,
    owner,
    executor,
    targetKind,
    baseRef,
    headRef,
    baseSha,
    headSha,
    policySha,
    protectedBranch,
    baseline,
    baselineState,
    baselineReason,
    gateId,
    pullRequest,
    workflowRunId,
    workflowRunAttempt,
  };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new CliArgumentError(`Missing required flag --${flag}`);
  return value;
}

function fullSha(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag);
  if (!commitSha.test(value)) throw new CliArgumentError(`--${flag} must be a lowercase 40-character commit SHA`);
  return value;
}

function humanRef(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag).trim();
  if (
    value.length === 0
    || value.length > 255
    || value.toUpperCase() === "HEAD"
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new CliArgumentError(`--${flag} is invalid`);
  return value;
}

function relativePath(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag).replaceAll("\\", "/");
  if (
    value.length === 0
    || value.length > 4_096
    || value.startsWith("/")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new CliArgumentError(`--${flag} must be a repository-relative path`);
  return value;
}

function slug(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag);
  if (!safeSlug.test(value)) throw new CliArgumentError(`--${flag} is invalid`);
  return value;
}

function identifier(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag);
  if (!safeIdentifier.test(value)) throw new CliArgumentError(`--${flag} is invalid`);
  return value;
}

function numericIdentifier(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag);
  if (!repositoryIdPattern.test(value)) throw new CliArgumentError(`--${flag} must be numeric`);
  return value;
}

function positiveInteger(values: ReadonlyMap<string, string>, flag: string): number {
  const value = Number(required(values, flag));
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliArgumentError(`--${flag} must be a positive integer`);
  return value;
}

function optionalPositiveInteger(values: ReadonlyMap<string, string>, flag: string): number | null {
  if (!values.has(flag)) return null;
  return positiveInteger(values, flag);
}

function isTargetKind(value: string): value is GateCliTargetKind {
  return value === "compare" || value === "protected_branch" || value === "pull_request";
}

function isBaselineState(value: string): value is GateCliBaselineState {
  return value === "absent" || value === "available" || value === "unavailable";
}
