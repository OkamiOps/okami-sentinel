/**
 * Accepts provider-native structured output, raw JSON text, or one unambiguous
 * JSON code fence. Provider prose may surround that single fence;
 * multiple/nested fences and scalar JSON remain unstructured.
 */
export function parseStructuredResult(value: unknown, text: string | null): unknown | null {
  if (value !== undefined && value !== null && (Array.isArray(value) || isPlainRecord(value))) {
    return value;
  }
  if (text === null) return null;

  const trimmed = text.trim();
  const direct = parseObjectOrArray(trimmed);
  if (direct !== null) return direct;

  const fences = [...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
  if (fences.length !== 1) return null;
  const fence = fences[0]!;
  const start = fence.index ?? -1;
  if (start < 0) return null;
  const outsideFence = trimmed.slice(0, start) + trimmed.slice(start + fence[0].length);
  if (outsideFence.includes("```")) return null;

  return parseObjectOrArray(fence[1] ?? "");
}

function parseObjectOrArray(candidate: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) || isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
