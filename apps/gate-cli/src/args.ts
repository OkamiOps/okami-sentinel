export interface RunGateCliOptions {
  repository: string;
  baseRef: string;
  headRef: string;
  policy: string;
  output: string;
  repositoryKey: string;
  repositoryName: string;
  defaultBranch: string;
  owner: string | null;
  baseline: string | null;
  gateId: string | null;
  pullRequest: number | null;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const requiredFlags = [
  "repository",
  "base-ref",
  "head-ref",
  "policy",
  "output",
  "repository-key",
  "repository-name",
  "default-branch",
] as const;
const optionalFlags = ["owner", "baseline", "gate-id", "pull-request"] as const;
const allowedFlags = new Set<string>([...requiredFlags, ...optionalFlags]);
const commitSha = /^[0-9a-f]{40}$/i;

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

  const baseRef = required(values, "base-ref");
  const headRef = required(values, "head-ref");
  if (!commitSha.test(baseRef)) throw new CliArgumentError("--base-ref must be a 40-character commit SHA");
  if (!commitSha.test(headRef)) throw new CliArgumentError("--head-ref must be a 40-character commit SHA");

  const pullRequestValue = values.get("pull-request");
  const pullRequest = pullRequestValue === undefined ? null : Number(pullRequestValue);
  if (pullRequest !== null && !Number.isInteger(pullRequest)) {
    throw new CliArgumentError("--pull-request must be numeric");
  }

  return {
    repository: required(values, "repository"),
    baseRef,
    headRef,
    policy: required(values, "policy"),
    output: required(values, "output"),
    repositoryKey: required(values, "repository-key"),
    repositoryName: required(values, "repository-name"),
    defaultBranch: required(values, "default-branch"),
    owner: values.get("owner") ?? null,
    baseline: values.get("baseline") ?? null,
    gateId: values.get("gate-id") ?? null,
    pullRequest,
  };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new CliArgumentError(`Missing required flag --${flag}`);
  return value;
}
