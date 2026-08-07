import type { GuardrailPolicy } from "@csb/shared";

export function defaultGuardrailPolicy(): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: ["main"],
    scope: { mode: "changed", maxChangedPaths: 50, fallback: "repository" },
    scan: { model: "gpt-5.6-sol", effort: "high", mode: "standard", maxCostUsd: 18 },
    rules: [
      { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
      { severity: ["high"], lifecycle: ["new", "reopened"], decision: "block" },
      { severity: ["high"], lifecycle: ["persistent"], decision: "review" },
    ],
  };
}
