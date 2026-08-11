import fs from "node:fs";
import path from "node:path";
import { normalizeSeverity } from "@csb/shared";

export interface MantisFindingRecord extends Record<string, unknown> {
  id?: string;
  title?: string;
  description?: string;
  code_paths?: string[];
  impact?: string;
  severity?: string;
  remediation?: string;
  mitigation?: string;
  status?: string;
  reasoning?: string;
  production_viability?: string;
  critic_reasoning?: string;
  mantis_risk_score?: number;
  priority?: string;
  cwe?: string;
  signature?: string;
  discovery_commit?: string;
  attacker_position?: string;
  privileges_required?: string;
  user_interaction?: string;
}

interface MantisLocation extends Record<string, unknown> {
  path: string;
  startLine?: number;
  endLine?: number;
  lines?: string;
  role: "primary";
}

function parseLocation(locator: string): MantisLocation {
  const match = locator.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: locator, role: "primary" };
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  return {
    path: match[1],
    startLine,
    endLine,
    lines: startLine === endLine ? String(startLine) : `${startLine}-${endLine}`,
    role: "primary",
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function languageForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
    ".sql": "sql",
    ".sh": "shell",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".json": "json",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".md": "markdown",
    ".toml": "toml",
  } as Record<string, string>)[extension] ?? "text";
}

function sourceSnippet(snapshotRoot: string | null, location: MantisLocation): string | null {
  if (!snapshotRoot || location.startLine == null) return null;
  let root: string;
  try {
    root = fs.realpathSync(snapshotRoot);
  } catch {
    return null;
  }
  const target = path.resolve(root, location.path);
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(root, realTarget);
    if (realRelative === "" || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      return null;
    }
    const stat = fs.statSync(realTarget);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const lines = fs.readFileSync(realTarget, "utf8").split(/\r?\n/);
    const start = Math.max(1, location.startLine);
    const requestedEnd = location.endLine ?? start;
    let end = Math.min(lines.length, requestedEnd, start + 199);
    if (start > lines.length || end < start) return null;
    let excerpt = lines.slice(start - 1, end).join("\n");
    if (!excerpt.trim() && end < lines.length) {
      end = Math.min(lines.length, end + 2, start + 199);
      excerpt = lines.slice(start - 1, end).join("\n");
    }
    return excerpt;
  } catch {
    return null;
  }
}

function locationLabel(location: MantisLocation): string {
  if (location.startLine == null) return location.path;
  const end = location.endLine ?? location.startLine;
  return `${location.path}:${location.startLine}${end !== location.startLine ? `–${end}` : ""}`;
}

function confidenceForStatus(status: string | undefined): {
  level: "high" | "medium" | "low";
  rationale: string;
} {
  if (status === "VALID") {
    return { level: "high", rationale: "Mantis review marked the finding VALID." };
  }
  if (status === "NEEDS_RESEARCH") {
    return { level: "low", rationale: "Mantis preserved the finding for additional research." };
  }
  return {
    level: "medium",
    rationale: "Mantis preserved the finding as provisionally valid after static review.",
  };
}

export function isReportableMantisFinding(finding: MantisFindingRecord): boolean {
  if (["FALSE_POSITIVE", "DUPLICATE"].includes(String(finding.status ?? ""))) return false;
  if (["NON_VIABLE", "SAMPLE_OR_TEST"].includes(String(finding.production_viability ?? ""))) {
    return false;
  }
  return Boolean(finding.id && finding.title && finding.severity);
}

export function normalizeMantisFinding(
  finding: MantisFindingRecord,
  snapshotRoot: string | null = null,
): Record<string, unknown> {
  const id = String(finding.id);
  const locations = (finding.code_paths ?? [])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(parseLocation);
  const severity = normalizeSeverity(finding.severity);
  const confidence = confidenceForStatus(finding.status);
  const rationale = [finding.reasoning, finding.critic_reasoning]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join(" ");
  const evidenceRefs = locations.map((_, index) => `evidence-${index + 1}`);
  const validationMethod = [
    text(finding.status) ? `Mantis review: ${text(finding.status)}` : null,
    text(finding.production_viability)
      ? `production viability: ${text(finding.production_viability)}`
      : null,
  ].filter((value): value is string => Boolean(value)).join(" · ") || null;
  const preconditions = [
    text(finding.privileges_required)
      ? `Privileges required: ${text(finding.privileges_required)}`
      : null,
    text(finding.user_interaction)
      ? `user interaction: ${text(finding.user_interaction)}`
      : null,
  ].filter((value): value is string => Boolean(value)).join(" · ") || null;

  return {
    findingId: `mantis-${id}`,
    occurrenceId: id,
    title: finding.title,
    summary: finding.description ?? finding.impact ?? finding.title,
    severity: {
      level: severity,
      rationale: finding.priority
        ? `Mantis priority ${finding.priority}${finding.mantis_risk_score ? ` · risk ${finding.mantis_risk_score}` : ""}.`
        : null,
    },
    confidence,
    ruleId: finding.cwe ? `mantis/${finding.cwe}` : "mantis/agentic-review",
    remediation: text(finding.remediation) ?? text(finding.mitigation),
    locations,
    codeEvidence: locations.map((location, index) => ({
      id: evidenceRefs[index],
      label: `Evidence at ${locationLabel(location)}`,
      ...location,
      role: "evidence",
      code: sourceSnippet(snapshotRoot, location),
      language: languageForPath(location.path),
      explanation: rationale || "Reported by the Mantis review pipeline.",
    })),
    taxonomy: {
      category: "Mantis agentic review",
      cwe: finding.cwe ? [finding.cwe] : [],
    },
    attackPath: {
      summary: text(finding.reasoning),
      evidenceRefs,
      reachability: {
        attacker: text(finding.attacker_position),
        preconditions,
      },
      dataflow: {
        summary: text(finding.reasoning),
        outcome: text(finding.impact),
        evidenceRefs,
      },
    },
    rootCause: {
      summary: text(finding.reasoning),
    },
    validation: {
      status: finding.status ?? null,
      summary: text(finding.reasoning),
      method: validationMethod,
      productionViability: finding.production_viability ?? null,
      supportingEvidence: text(finding.critic_reasoning)
        ? [text(finding.critic_reasoning)]
        : [],
    },
    fingerprints: {
      algorithm: "google-mantis/v1",
      primary: finding.signature
        ? `google-mantis/v1:fingerprint:${finding.signature}`
        : `google-mantis/v1:fingerprint:${id}`,
      mantisId: id,
      snapshot: finding.discovery_commit ?? "unknown",
    },
    provenance: {
      source: "google-mantis",
      rawFinding: `mantis/workspace/findings/${id}.json`,
    },
  };
}

export function readMantisFindingRecords(stateRoot: string): MantisFindingRecord[] {
  const findingsDir = path.join(stateRoot, "workspace", "findings");
  if (!fs.existsSync(findingsDir)) return [];
  return fs
    .readdirSync(findingsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      try {
        return [
          JSON.parse(fs.readFileSync(path.join(findingsDir, entry.name), "utf8")) as MantisFindingRecord,
        ];
      } catch {
        return [];
      }
    });
}

export function normalizeMantisWorkspace(stateRoot: string, outputDir: string): number {
  const raw = readMantisFindingRecords(stateRoot);
  const snapshotRoot = path.join(outputDir, "mantis-snapshot");
  const findings = raw
    .filter(isReportableMantisFinding)
    .map((finding) => normalizeMantisFinding(
      finding,
      fs.existsSync(snapshotRoot) ? snapshotRoot : null,
    ));
  const payload = {
    schemaVersion: 1,
    engine: "mantis",
    generatedAt: new Date().toISOString(),
    sourceFindings: raw.length,
    findings,
  };
  const target = path.join(outputDir, "findings.json");
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  return findings.length;
}
