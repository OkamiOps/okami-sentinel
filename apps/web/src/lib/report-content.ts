export const REPORT_TRUNCATION_MARKER = "Excerpt bounded for PDF — open the full finding in Sentinel.";

export interface ReportExcerptOptions {
  maxChars?: number;
  maxLines?: number;
  marker?: string;
}

export interface ReportExcerpt {
  text: string;
  truncated: boolean;
}

export interface ReportEvidenceBlock {
  id: string;
  label: string;
  path: string;
  role: string;
  explanation: ReportExcerpt;
  code: ReportExcerpt;
}

export function normalizeReportText(value: string): string {
  return value
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export function reportExcerpt(value: string, options: ReportExcerptOptions = {}): ReportExcerpt {
  const maxChars = options.maxChars ?? 720;
  const maxLines = options.maxLines ?? 9;
  const marker = options.marker ?? REPORT_TRUNCATION_MARKER;
  const normalized = normalizeReportText(value);
  const sourceLines = normalized.split("\n");
  let text = sourceLines.slice(0, maxLines).join("\n");
  let truncated = sourceLines.length > maxLines;

  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd();
    truncated = true;
  }

  return {
    text: truncated ? `${text}\n… ${marker}` : text,
    truncated,
  };
}

export function reportEvidenceBlocks(value: unknown, limit = 2): { blocks: ReportEvidenceBlock[]; hidden: number } {
  const entries = Array.isArray(value) ? value : [];
  const blocks = entries.slice(0, limit).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const path = text(record.path) ?? "Evidence artifact";
    const start = integer(record.startLine);
    const end = integer(record.endLine);
    const range = start == null ? "" : `:${start}${end != null && end !== start ? `–${end}` : ""}`;
    return [{
      id: text(record.id) ?? `evidence-${index + 1}`,
      label: text(record.label) ?? `${path}${range}`,
      path: `${path}${range}`,
      role: text(record.role) ?? "evidence",
      explanation: reportExcerpt(text(record.explanation) ?? "Structured evidence attached by the scanner.", { maxChars: 160, maxLines: 2 }),
      code: reportExcerpt(text(record.code) ?? "No source excerpt was attached.", { maxChars: 300, maxLines: 5 }),
    } satisfies ReportEvidenceBlock];
  });
  return { blocks, hidden: Math.max(0, entries.length - blocks.length) };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
