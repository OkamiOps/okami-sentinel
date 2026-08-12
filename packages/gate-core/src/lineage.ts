import { createHash } from "node:crypto";
import type { EffectiveScanLineage } from "@csb/shared";

export type BuildScanLineageInput = Omit<EffectiveScanLineage, "scanLineageHash">;

const hashPattern = /^sha256:[0-9a-f]{64}$/;

export function buildScanLineage(input: BuildScanLineageInput): EffectiveScanLineage {
  const lineage: BuildScanLineageInput = {
    engine: lineageText(input.engine, "engine"),
    engineVersion: lineageText(input.engineVersion, "engineVersion"),
    route: lineageText(input.route, "route"),
    protocol: lineageText(input.protocol, "protocol"),
    provider: lineageText(input.provider, "provider"),
    model: lineageText(input.model, "model"),
    reasoningEffort: lineageText(input.reasoningEffort, "reasoningEffort"),
    methodology: lineageText(input.methodology, "methodology"),
    profile: lineageText(input.profile, "profile"),
    recipeHash: canonicalHash(input.recipeHash, "recipeHash"),
    sourceRevision: canonicalHash(input.sourceRevision, "sourceRevision"),
  };
  const canonical = JSON.stringify([
    lineage.engine,
    lineage.engineVersion,
    lineage.route,
    lineage.protocol,
    lineage.provider,
    lineage.model,
    lineage.reasoningEffort,
    lineage.methodology,
    lineage.profile,
    lineage.recipeHash,
    lineage.sourceRevision,
  ]);
  return {
    ...lineage,
    scanLineageHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  };
}

function lineageText(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || /file:\/\//i.test(value)
    || /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
  ) {
    throw new Error(`ScanLineage.${field} inválido`);
  }
  return value;
}

function canonicalHash(value: unknown, field: string): string {
  const parsed = lineageText(value, field);
  if (!hashPattern.test(parsed)) {
    throw new Error(`ScanLineage.${field} deve ser sha256 canônico`);
  }
  return parsed;
}
