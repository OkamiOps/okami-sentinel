import { defaultGuardrailPolicy } from "@csb/gate-core";
import {
  parseGuardrailExceptions,
  parseGuardrailPolicy,
} from "@csb/gate-runtime";
import type {
  GateArtifactV2,
  GateTarget,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
  ResolvedGateTarget,
} from "@csb/shared";

import type { GitHubRepositoryReader } from "./repository-source-adapter.js";

const POLICY_PATH = ".csb/guardrails.json";
const EXCEPTIONS_PATH = ".csb/guardrails-exceptions.json";

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
  policy: GuardrailPolicy;
  exceptions: GuardrailException[];
  policySource: GateArtifactV2["policySource"];
  policySha: string;
}

export class ProtectedPolicyLoader {
  constructor(readonly reader: GitHubRepositoryReader) {}

  async load(
    repository: GuardrailRepository,
    target: GateTarget,
    resolved: ResolvedGateTarget,
  ): Promise<ProtectedPolicyBundle> {
    const [policyFile, exceptionsFile] = await Promise.all([
      this.reader.readFile(repository, resolved.policySha, POLICY_PATH),
      this.reader.readFile(repository, resolved.policySha, EXCEPTIONS_PATH),
    ]);

    let policy: GuardrailPolicy;
    let policySource: GateArtifactV2["policySource"];
    if (policyFile === null) {
      policy = defaultGuardrailPolicy();
      policySource = "default";
    } else {
      try {
        policy = parseGuardrailPolicy(JSON.parse(policyFile.content));
      } catch {
        throw new ProtectedPolicyLoaderError("protected_policy_invalid");
      }
      policySource = target.kind === "protected_branch" ? "protected_branch" : "base";
    }

    let exceptions: GuardrailException[] = [];
    if (exceptionsFile !== null) {
      try {
        exceptions = parseGuardrailExceptions(JSON.parse(exceptionsFile.content));
      } catch {
        throw new ProtectedPolicyLoaderError("protected_exceptions_invalid");
      }
    }

    return {
      policy,
      exceptions,
      policySource,
      policySha: resolved.policySha,
    };
  }
}
