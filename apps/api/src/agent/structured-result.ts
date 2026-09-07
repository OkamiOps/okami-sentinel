/**
 * Accepts provider-native structured output, raw JSON text, or one unambiguous
 * JSON code fence. Provider prose may surround that single fence;
 * multiple/nested fences and scalar JSON remain unstructured.
 */
export type StructuredResultRejection = "syntax" | "non-structured" | "ambiguous-fences";

export function parseStructuredResult(
  value: unknown,
  text: string | null,
  onReject?: (reason: StructuredResultRejection) => void,
): unknown | null {
  if (value !== undefined && value !== null && (Array.isArray(value) || isPlainRecord(value))) {
    return value;
  }
  if (text === null) {
    onReject?.("non-structured");
    return null;
  }

  const trimmed = text.trim();
  let directReason: StructuredResultRejection = "syntax";
  const direct = parseObjectOrArray(trimmed, (reason) => { directReason = reason; });
  if (direct !== null) return direct;

  const fences = [...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
  if (fences.length !== 1) {
    onReject?.(fences.length > 1 ? "ambiguous-fences" : directReason);
    return null;
  }
  const fence = fences[0]!;
  const start = fence.index ?? -1;
  if (start < 0) return null;
  const outsideFence = trimmed.slice(0, start) + trimmed.slice(start + fence[0].length);
  if (outsideFence.includes("```")) {
    onReject?.("ambiguous-fences");
    return null;
  }

  return parseObjectOrArray(fence[1] ?? "", onReject);
}

function parseObjectOrArray(
  candidate: string,
  onReject?: (reason: StructuredResultRejection) => void,
): unknown | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (Array.isArray(parsed) || isPlainRecord(parsed)) return parsed;
    onReject?.("non-structured");
    return null;
  } catch {
    // Never expose JSON.parse messages: some engines include provider content.
    onReject?.("syntax");
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
