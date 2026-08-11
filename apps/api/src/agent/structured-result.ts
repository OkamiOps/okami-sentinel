/**
 * Accepts provider-native structured output, raw JSON text, or one exact JSON
 * code fence. Leading prose, trailing prose, nested fences, and scalar JSON
 * remain unstructured.
 */
export function parseStructuredResult(value: unknown, text: string | null): unknown | null {
  if (value !== undefined && value !== null && (Array.isArray(value) || isPlainRecord(value))) {
    return value;
  }
  if (text === null) return null;

  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
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
