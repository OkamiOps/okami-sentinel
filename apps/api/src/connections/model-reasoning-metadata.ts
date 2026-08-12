import type { ModelReasoningEffort } from "@csb/shared";

const OPTION_COLLECTION_KEYS = [
  "supportedReasoningEfforts",
  "supported_reasoning_efforts",
  "supported_reasoning_levels",
  "reasoningEfforts",
  "reasoning_efforts",
] as const;

const DEFAULT_KEYS = [
  "defaultReasoningEffort",
  "default_reasoning_effort",
  "default_reasoning_level",
] as const;

const OPTION_KEYS = ["reasoningEffort", "reasoning_effort", "effort"] as const;
const NESTED_OPTION_COLLECTION_KEYS = ["supported_efforts"] as const;
const NESTED_DEFAULT_KEYS = ["default_effort"] as const;
const OPENROUTER_GATEWAY_EFFORTS = [
  "max", "xhigh", "high", "medium", "low", "minimal", "none",
] as const;

/**
 * Normalizes reasoning metadata only when a runtime/provider catalog publishes
 * it. Model IDs and provider names never participate in this decision.
 */
export function reasoningEffortFromModelRecord(
  record: Record<string, unknown>,
  sensitiveValues: readonly string[] = [],
): ModelReasoningEffort | undefined {
  const reasoning = isRecord(record.reasoning) ? record.reasoning : undefined;
  const acceptsAllGatewayEfforts = reasoning !== undefined &&
    Object.hasOwn(reasoning, "supported_efforts") &&
    reasoning.supported_efforts === null;
  const collection = acceptsAllGatewayEfforts
    ? OPENROUTER_GATEWAY_EFFORTS
    : firstArray(record, OPTION_COLLECTION_KEYS) ??
    (reasoning === undefined ? undefined : firstArray(reasoning, NESTED_OPTION_COLLECTION_KEYS));
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of collection ?? []) {
    const candidate = typeof item === "string"
      ? safeEffort(item)
      : isRecord(item)
        ? firstEffort(item, OPTION_KEYS)
        : undefined;
    if (candidate !== undefined && !seen.has(candidate)) {
      seen.add(candidate);
      options.push(candidate);
    }
  }
  if (reasoning?.mandatory === true) {
    const noneIndex = options.indexOf("none");
    if (noneIndex >= 0) {
      options.splice(noneIndex, 1);
      seen.delete("none");
    }
  }

  const reportedDefault = firstEffort(record, DEFAULT_KEYS) ??
    (reasoning === undefined ? undefined : firstEffort(reasoning, NESTED_DEFAULT_KEYS));
  const metadata: ModelReasoningEffort | undefined = options.length === 0
    ? reportedDefault === undefined
      ? undefined
      : { options: [reportedDefault], default: reportedDefault }
    : {
        options,
        default: reportedDefault !== undefined && seen.has(reportedDefault)
          ? reportedDefault
          : null,
      };
  return metadata !== undefined && containsSensitiveValue(metadata, sensitiveValues)
    ? undefined
    : metadata;
}

function containsSensitiveValue(
  metadata: ModelReasoningEffort,
  sensitiveValues: readonly string[],
): boolean {
  const values = metadata.default === null
    ? metadata.options
    : [...metadata.options, metadata.default];
  return sensitiveValues.some((secret) =>
    secret.length > 0 && values.some((value) => value.includes(secret))
  );
}

function firstArray(
  record: Record<string, unknown>,
  keys: readonly string[],
): readonly unknown[] | undefined {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  return undefined;
}

function firstEffort(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const effort = safeEffort(record[key]);
    if (effort !== undefined) return effort;
  }
  return undefined;
}

function safeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim();
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(effort) ? effort : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
