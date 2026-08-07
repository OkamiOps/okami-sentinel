import type {
  ChangeSet,
  DecisionGraph,
  DecisionGraphNode,
  GateDecision,
  GateFindingDelta,
  GateOutcome,
  GateViolation,
} from "@csb/shared";

type EvaluatedDecision = Omit<GateDecision, "decisionGraph">;

const lifecycleLabels: Record<GateFindingDelta["lifecycle"], string> = {
  new: "novo",
  reopened: "reaberto",
  persistent: "persistente",
  fixed: "corrigido",
};

export function buildDecisionGraph(
  changeSet: ChangeSet,
  deltas: GateFindingDelta[],
  decision: EvaluatedDecision,
): DecisionGraph {
  const primaryRule = decision.violations[0] ?? decision.warnings[0] ?? null;
  const primaryFinding = primaryRule
    ? deltas.find((finding) => finding.identity === primaryRule.findingIdentity) ?? null
    : deltas.find((finding) => finding.lifecycle !== "fixed") ?? null;
  const surface = primaryFinding?.category
    ?? primaryFinding?.primaryPath
    ?? "Não determinado";
  const findingIdentity = primaryFinding?.identity ?? null;

  const nodes: DecisionGraphNode[] = [
    {
      id: "changeset",
      kind: "changeset",
      label: "Changeset",
      value: `${changeSet.files.length} arquivo(s) alterado(s)`,
      detail: `${changeSet.baseSha} → ${changeSet.headSha}`,
      tone: "neutral",
      findingIdentity: null,
    },
    {
      id: "surface",
      kind: "surface",
      label: "Superfície",
      value: surface,
      detail: primaryFinding?.category ? primaryFinding.primaryPath : null,
      tone: surface === "Não determinado" ? "neutral" : signalTone(primaryRule),
      findingIdentity,
    },
    {
      id: "signal",
      kind: "signal",
      label: "Sinal",
      value: primaryFinding
        ? `${primaryFinding.title} ${lifecycleLabels[primaryFinding.lifecycle]}`
        : "Não determinado",
      detail: primaryFinding
        ? `${primaryFinding.severity}${primaryFinding.confidence ? ` · ${primaryFinding.confidence}` : ""}`
        : null,
      tone: signalTone(primaryRule),
      findingIdentity,
    },
    {
      id: "rule",
      kind: "rule",
      label: "Regra",
      value: ruleValue(primaryRule),
      detail: primaryRule ? `Regra ${primaryRule.ruleIndex + 1}` : null,
      tone: signalTone(primaryRule),
      findingIdentity: primaryRule?.findingIdentity ?? null,
    },
    {
      id: "verdict",
      kind: "verdict",
      label: "Veredito",
      value: decision.outcome.toUpperCase(),
      detail: decision.summary,
      tone: verdictTone(decision.outcome),
      findingIdentity,
    },
  ];

  return { nodes, selectedNodeId: "signal" };
}

function ruleValue(rule: GateViolation | null): string {
  if (!rule) return "Nenhuma regra acionada";
  return `${rule.decision === "block" ? "Bloquear" : "Revisar"} ${rule.reason}`;
}

function signalTone(rule: GateViolation | null): DecisionGraphNode["tone"] {
  if (!rule) return "neutral";
  return rule.decision === "block" ? "risk" : "warning";
}

function verdictTone(outcome: GateOutcome): DecisionGraphNode["tone"] {
  if (outcome === "blocked" || outcome === "error") return "risk";
  if (outcome === "warning" || outcome === "bootstrap") return "warning";
  return "good";
}
