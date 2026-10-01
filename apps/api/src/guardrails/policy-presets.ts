import { defaultGuardrailPolicy } from "@csb/gate-core";
import {
  guardrailPolicyPresetRules,
  type GuardrailPolicy,
  type GuardrailPolicyPreset,
} from "@csb/shared";

export {
  DEFAULT_GUARDRAIL_POLICY_PRESET,
  GUARDRAIL_POLICY_PRESETS,
  guardrailPolicyPresetOf as presetForPolicy,
  isGuardrailPolicyPreset,
  type GuardrailPolicyPreset,
} from "@csb/shared";

/**
 * A whole policy for a preset: the preset's rules over the product's default scope
 * and scan envelope, with the protected branches the operator named.
 *
 * The rules themselves live in `@csb/shared`, because the picker on the repository
 * page has to recognise exactly what this writes.
 */
export function policyForPreset(
  preset: GuardrailPolicyPreset,
  protectedBranches: readonly string[],
): GuardrailPolicy {
  const fallback = defaultGuardrailPolicy();
  return {
    schemaVersion: 1,
    protectedBranches: protectedBranches.length > 0
      ? [...protectedBranches]
      : [...fallback.protectedBranches],
    scope: { ...fallback.scope },
    scan: { ...fallback.scan },
    rules: guardrailPolicyPresetRules(preset),
  };
}
