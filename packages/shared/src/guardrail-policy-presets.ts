import type { GateFindingLifecycle, GuardrailPolicy, GuardrailRule, Severity } from "./index.js";

/**
 * The four words the interface offers for "what does this repository block".
 *
 * `custom` is not a shape: it is what `guardrailPolicyPresetOf` answers when the
 * rules match none of the three, which is the only honest answer for a policy
 * somebody edited rule by rule.
 *
 * The shapes live in `@csb/shared` because both sides read them: the API decides
 * what is stored, and the picker on the repository page decides what the operator
 * is looking at. Two copies would be two answers to the same question.
 */
export type GuardrailPolicyPreset =
  | "block-critical-high"
  | "block-critical"
  | "warn-only"
  | "custom";

export const GUARDRAIL_POLICY_PRESETS: readonly GuardrailPolicyPreset[] = [
  "block-critical-high",
  "block-critical",
  "warn-only",
  "custom",
];

/** The default a repository gets the first time a policy is saved for it. */
export const DEFAULT_GUARDRAIL_POLICY_PRESET: GuardrailPolicyPreset = "block-critical-high";

export function isGuardrailPolicyPreset(value: unknown): value is GuardrailPolicyPreset {
  return typeof value === "string"
    && GUARDRAIL_POLICY_PRESETS.includes(value as GuardrailPolicyPreset);
}

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];
/** A rule never decides about `fixed`: the finding is gone. */
const EVALUATED_LIFECYCLES: readonly GateFindingLifecycle[] = ["new", "reopened", "persistent"];
const ARRIVING: readonly GateFindingLifecycle[] = ["new", "reopened"];

/**
 * The rules are deliberately disjoint. The evaluator applies **every** matching rule
 * rather than the first one, so a catch-all "review everything" laid over a block
 * rule would record the same critical finding as both a violation and a warning —
 * the verdict would still be blocked, but the screen and the comment would
 * double-count it.
 */
function rulesBlocking(blocking: readonly Severity[]): GuardrailRule[] {
  const remaining = SEVERITY_ORDER.filter((severity) => !blocking.includes(severity));
  const rules: GuardrailRule[] = [
    { severity: [...blocking], lifecycle: [...ARRIVING], decision: "block" },
    { severity: [...blocking], lifecycle: ["persistent"], decision: "review" },
  ];
  if (remaining.length > 0) {
    rules.push({ severity: remaining, lifecycle: [...EVALUATED_LIFECYCLES], decision: "review" });
  }
  return rules;
}

const PRESET_RULES: Record<Exclude<GuardrailPolicyPreset, "custom">, () => GuardrailRule[]> = {
  "block-critical-high": () => rulesBlocking(["critical", "high"]),
  "block-critical": () => rulesBlocking(["critical"]),
  // Nothing blocks, so there is nothing to split: one rule covers every severity.
  "warn-only": () => [{
    severity: [...SEVERITY_ORDER],
    lifecycle: [...EVALUATED_LIFECYCLES],
    decision: "review",
  }],
};

/**
 * The rules a preset stands for. A preset decides **only** the rules: the protected
 * branches are the operator's answer to a different question, and the scan envelope
 * is what a run costs — picking a preset must not silently re-price a scan.
 */
export function guardrailPolicyPresetRules(preset: GuardrailPolicyPreset): GuardrailRule[] {
  if (preset === "custom") throw new Error("guardrail_policy_preset_custom");
  return PRESET_RULES[preset]();
}

export function guardrailPolicyPresetOf(
  policy: Pick<GuardrailPolicy, "rules">,
): GuardrailPolicyPreset {
  const actual = canonicalRules(policy.rules);
  for (const preset of ["block-critical-high", "block-critical", "warn-only"] as const) {
    if (actual === canonicalRules(PRESET_RULES[preset]())) return preset;
  }
  return "custom";
}

/**
 * Order inside a rule's two lists is not meaning — `["high","critical"]` decides
 * exactly what `["critical","high"]` decides — so a hand-sorted file must not read
 * as `custom`. Order *between* rules is kept, because two rules that disagree about
 * the same pair are a different policy.
 */
function canonicalRules(rules: readonly GuardrailRule[]): string {
  return JSON.stringify(rules.map((rule) => ({
    severity: SEVERITY_ORDER.filter((severity) => rule.severity.includes(severity)),
    lifecycle: ([...EVALUATED_LIFECYCLES, "fixed"] as const)
      .filter((lifecycle) => rule.lifecycle.includes(lifecycle)),
    decision: rule.decision,
  })));
}
