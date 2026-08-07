import type {
  DecisionGraph,
  DecisionGraphNode,
  GateArtifact,
  GateFindingDelta,
  GateOutcome,
  GateRun,
  GateStatus,
} from "@csb/shared";

export type GateTone = "neutral" | "good" | "warning" | "risk" | "active";

export interface EvidenceRow {
  label: string;
  value: string;
}

export interface NodeEvidence {
  title: string;
  summary: string;
  rows: EvidenceRow[];
  finding: GateFindingDelta | null;
}

const activeStatuses = new Set<GateStatus>([
  "queued",
  "resolving",
  "scanning",
  "evaluating",
  "publishing",
]);

export function selectGate(
  gates: readonly GateRun[],
  requestedId: string | null,
): GateRun | null {
  const requested = requestedId
    ? gates.find((gate) => gate.id === requestedId)
    : null;
  if (requested) return requested;
  const blocked = gates.find((gate) => gate.outcome === "blocked");
  if (blocked) return blocked;
  const scanning = gates.find((gate) => gate.status === "scanning");
  if (scanning) return scanning;
  return [...gates].sort(
    (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
  )[0] ?? null;
}

export function selectDecisionNode(
  graph: DecisionGraph,
  requestedId: string | null,
): DecisionGraphNode | null {
  return (
    (requestedId
      ? graph.nodes.find((node) => node.id === requestedId)
      : null) ??
    graph.nodes.find((node) => node.id === graph.selectedNodeId) ??
    graph.nodes[0] ??
    null
  );
}

export function guardrailHref(gateId: string, nodeId?: string | null): string {
  const path = `/guardrails/${encodeURIComponent(gateId)}`;
  return nodeId ? `${path}?node=${encodeURIComponent(nodeId)}` : path;
}

export function gateStageLabel(status: GateStatus): string {
  const labels: Record<GateStatus, string> = {
    queued: "Na fila",
    resolving: "Resolvendo diff",
    scanning: "Scan em curso",
    evaluating: "Avaliando política",
    publishing: "Publicando check",
    completed: "Concluído",
    cancelled: "Cancelado",
    error: "Falha operacional",
  };
  return labels[status];
}

export function gateOutcomeTone(outcome: GateOutcome | null): GateTone {
  if (outcome === "blocked" || outcome === "error") return "risk";
  if (outcome === "warning" || outcome === "bootstrap") return "warning";
  if (outcome === "pass" || outcome === "no_changes") return "good";
  return "neutral";
}

export function isGateActive(status: GateStatus): boolean {
  return activeStatuses.has(status);
}

export function evidenceForNode(
  artifact: GateArtifact,
  node: DecisionGraphNode,
): NodeEvidence {
  const finding = node.findingIdentity
    ? artifact.findings.find((item) => item.identity === node.findingIdentity) ?? null
    : null;
  const fallback = "Não determinado";

  if (node.kind === "changeset") {
    return {
      title: node.label,
      summary: node.value || fallback,
      rows: [
        { label: "Base", value: artifact.changeSet.baseSha || fallback },
        { label: "Head", value: artifact.changeSet.headSha || fallback },
        {
          label: "Paths enviados",
          value: artifact.changeSet.scanPaths.length
            ? artifact.changeSet.scanPaths.join(", ")
            : fallback,
        },
      ],
      finding: null,
    };
  }

  if (node.kind === "verdict") {
    return {
      title: node.label,
      summary: artifact.decision.summary || fallback,
      rows: [
        { label: "Resultado", value: artifact.decision.outcome },
        { label: "Conclusão GitHub", value: artifact.decision.githubConclusion },
        {
          label: "Baseline",
          value: artifact.baselineCommit ?? fallback,
        },
      ],
      finding,
    };
  }

  if (node.kind === "rule") {
    const violation = [...artifact.decision.violations, ...artifact.decision.warnings]
      .find((item) => item.findingIdentity === node.findingIdentity);
    return {
      title: node.label,
      summary: node.value || fallback,
      rows: [
        {
          label: "Regra",
          value: violation ? String(violation.ruleIndex + 1) : fallback,
        },
        { label: "Decisão", value: violation?.decision ?? fallback },
        { label: "Motivo", value: violation?.reason ?? fallback },
      ],
      finding,
    };
  }

  return {
    title: node.label,
    summary: node.value || fallback,
    rows: [
      { label: "Finding", value: finding?.title ?? fallback },
      { label: "Severidade", value: finding?.severity ?? fallback },
      { label: "Lifecycle", value: finding?.lifecycle ?? fallback },
      { label: "Path", value: finding?.primaryPath ?? fallback },
    ],
    finding,
  };
}
