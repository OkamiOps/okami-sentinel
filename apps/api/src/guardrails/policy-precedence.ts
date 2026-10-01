import { defaultGuardrailPolicy } from "@csb/gate-core";
import type { GuardrailPolicy, GuardrailResolvedPolicySource } from "@csb/shared";

/**
 * The three levels of the spec's precedence table, in the order they win:
 *
 * 1. `repository_file` — `.csb/guardrails.json` at the protected branch's SHA. The
 *    repository is the authority; the Sentinel editor goes read-only and says so.
 * 2. `sentinel` — the policy saved in `guardrail_repository_policies`.
 * 3. `default` — `defaultGuardrailPolicy()`.
 */
export type ResolvedPolicySource = GuardrailResolvedPolicySource;

export interface ResolvedGuardrailPolicy {
  policy: GuardrailPolicy;
  source: ResolvedPolicySource;
  /** True only while level 1 is in force: the file is the thing to edit, not us. */
  readOnly: boolean;
  /**
   * Why the repository's own file was not obeyed. Never `null` while a file is
   * present and unusable — an invalid file must not fall through in silence.
   */
  fileInvalidReason: string | null;
}

export interface ProtectedPolicyFileState {
  /** Whether `.csb/guardrails.json` exists at the protected SHA at all. */
  present: boolean;
  /** The parsed policy, or `null` when the file is present and unusable. */
  policy: GuardrailPolicy | null;
  /** The code to report, e.g. `policy_invalid`, when the file cannot be used. */
  invalidReason: string | null;
}

export function resolveGuardrailPolicy(input: {
  protectedFile: ProtectedPolicyFileState;
  sentinel: GuardrailPolicy | null;
}): ResolvedGuardrailPolicy {
  const { protectedFile, sentinel } = input;
  if (protectedFile.present && protectedFile.policy !== null) {
    return {
      policy: copy(protectedFile.policy),
      source: "repository_file",
      readOnly: true,
      fileInvalidReason: null,
    };
  }
  // A file we could not turn into a policy always leaves a reason behind. If the
  // loader lost it, say so rather than report a clean fall-through.
  const fileInvalidReason = protectedFile.present
    ? protectedFile.invalidReason ?? "policy_unreadable"
    : null;
  if (sentinel !== null) {
    return { policy: copy(sentinel), source: "sentinel", readOnly: false, fileInvalidReason };
  }
  return {
    policy: defaultGuardrailPolicy(),
    source: "default",
    readOnly: false,
    fileInvalidReason,
  };
}

function copy(policy: GuardrailPolicy): GuardrailPolicy {
  return structuredClone(policy);
}
