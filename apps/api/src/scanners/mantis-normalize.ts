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
}

function parseLocation(locator: string): Record<string, unknown> {
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
    remediation: finding.mitigation ?? null,
    locations,
    codeEvidence: locations.map((location) => ({
      ...location,
      rationale: rationale || "Reported by the Mantis review pipeline.",
    })),
    taxonomy: {
      category: "Mantis agentic review",
      cwe: finding.cwe ? [finding.cwe] : [],
    },
    attackPath: {
      attackerPosition: finding.attacker_position ?? null,
      privilegesRequired: finding.privileges_required ?? null,
      userInteraction: finding.user_interaction ?? null,
      impact: finding.impact ?? null,
    },
    validation: {
      status: finding.status ?? null,
      reasoning: finding.reasoning ?? null,
      productionViability: finding.production_viability ?? null,
      criticReasoning: finding.critic_reasoning ?? null,
    },
    fingerprints: {
      mantisId: id,
      signature: finding.signature ?? id,
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
  const findings = raw.filter(isReportableMantisFinding).map(normalizeMantisFinding);
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
