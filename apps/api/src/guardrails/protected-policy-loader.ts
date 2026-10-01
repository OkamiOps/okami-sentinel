import {
  parseGuardrailExceptions,
  parseGuardrailPolicy,
} from "@csb/gate-runtime";
import type {
  GateTarget,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import { getRepositoryPolicy } from "./policy-store.js";
import {
  resolveGuardrailPolicy,
  type ResolvedPolicySource,
} from "./policy-precedence.js";
import type { GitHubRepositoryReader } from "./repository-source-adapter.js";

const POLICY_PATH = ".csb/guardrails.json";
const EXCEPTIONS_PATH = ".csb/guardrails-exceptions.json";

/** The code a gate, the screen and the PR comment all name an unusable file by. */
export const POLICY_INVALID_REASON = "policy_invalid";

export type ProtectedPolicyLoaderErrorCode =
  | "protected_policy_invalid"
  | "protected_exceptions_invalid";

export class ProtectedPolicyLoaderError extends Error {
  constructor(readonly code: ProtectedPolicyLoaderErrorCode) {
    super(code);
    this.name = "ProtectedPolicyLoaderError";
  }
}

export interface ProtectedPolicyBundle {
  /** The policy that actually decides: whichever level of the precedence won. */
  policy: GuardrailPolicy;
  exceptions: GuardrailException[];
  policySource: ResolvedPolicySource;
  policySha: string;
  /** True while the repository's own file is in force; the editor says so. */
  readOnly: boolean;
  /**
   * Why a file that **is** there was not obeyed, or `null`. An invalid file never
   * falls through in silence: the gate records this and the screen repeats it.
   */
  fileInvalidReason: string | null;
}

/** Reads the Sentinel-side policy; injectable so tests do not need a database. */
export type SentinelPolicyReader = (repositoryKey: string) => GuardrailPolicy | null;

const productionSentinelPolicy: SentinelPolicyReader = (repositoryKey) =>
  getRepositoryPolicy(repositoryKey)?.policy ?? null;

/**
 * Resolves the policy of a GitHub repository through the three-level precedence.
 *
 * The repository's own `.csb/guardrails.json` wins while it parses. A file that is
 * present and does not parse used to abort the whole gate with
 * `protected_policy_invalid`; it now falls to the Sentinel policy (or the product
 * default) and reports `policy_invalid`, so one bad commit to a config file cannot
 * stop every pull request from getting a verdict.
 */
export class ProtectedPolicyLoader {
  readonly #sentinelPolicy: SentinelPolicyReader;

  constructor(
    readonly reader: GitHubRepositoryReader,
    sentinelPolicy: SentinelPolicyReader = productionSentinelPolicy,
  ) {
    this.#sentinelPolicy = sentinelPolicy;
  }

  async load(
    repository: GuardrailRepository,
    _target: GateTarget,
    resolved: ResolvedGateTarget,
  ): Promise<ProtectedPolicyBundle> {
    const [policyFile, exceptionsFile] = await Promise.all([
      this.reader.readFile(repository, resolved.policySha, POLICY_PATH),
      this.reader.readFile(repository, resolved.policySha, EXCEPTIONS_PATH),
    ]);

    let filePolicy: GuardrailPolicy | null = null;
    let invalidReason: string | null = null;
    if (policyFile !== null) {
      try {
        filePolicy = parseGuardrailPolicy(JSON.parse(policyFile.content));
      } catch {
        invalidReason = POLICY_INVALID_REASON;
      }
    }

    const resolution = resolveGuardrailPolicy({
      protectedFile: { present: policyFile !== null, policy: filePolicy, invalidReason },
      sentinel: this.#sentinelPolicy(repository.repositoryKey),
    });

    // Exceptions stay a hard failure: unlike the policy there is no second level to
    // fall to, and silently dropping an exception would start blocking a finding
    // somebody deliberately excused.
    let exceptions: GuardrailException[] = [];
    if (exceptionsFile !== null) {
      try {
        exceptions = parseGuardrailExceptions(JSON.parse(exceptionsFile.content));
      } catch {
        throw new ProtectedPolicyLoaderError("protected_exceptions_invalid");
      }
    }

    return {
      policy: resolution.policy,
      exceptions,
      policySource: resolution.source,
      policySha: resolved.policySha,
      readOnly: resolution.readOnly,
      fileInvalidReason: resolution.fileInvalidReason,
    };
  }
}
