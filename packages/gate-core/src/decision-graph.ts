import type {
  ChangeSet,
  DecisionGraph,
  DecisionGraphNode,
  GateDecision,
  GateFindingDelta,
  GateOutcome,
  GateViolation,
} from "@csb/shared";
import { redactPublicText } from "./public-text.js";

type EvaluatedDecision = Omit<GateDecision, "decisionGraph">;

const lifecycleLabels: Record<GateFindingDelta["lifecycle"], string> = {
  new: "novo",
  reopened: "reaberto",
  persistent: "persistente",
  fixed: "corrigido",
};

const undetermined = "Não determinado";

export function buildDecisionGraph(
  changeSet: ChangeSet,
  deltas: GateFindingDelta[],
  decision: EvaluatedDecision,
): DecisionGraph {
  const primaryRule = decision.violations[0] ?? decision.warnings[0] ?? null;
  const primaryFinding = primaryRule
    ? deltas.find((finding) => finding.identity === primaryRule.findingIdentity) ?? null
    : deltas.find((finding) => finding.lifecycle !== "fixed") ?? null;
  // Every value below can carry scanner text, so it is redacted and backed by a
  // non-empty fallback for the fields the artifact validator requires.
  const category = publicText(primaryFinding?.category ?? "");
  const path = publicText(primaryFinding?.primaryPath ?? "");
  const surface = category || path || undetermined;
  const findingIdentity = primaryFinding?.identity ?? null;
  const outcomeLabel = decision.outcome.toUpperCase();
  const verdict = publicText(outcomeLabel) || outcomeLabel;

  const nodes: DecisionGraphNode[] = [
    {
      id: "changeset",
      kind: "changeset",
      label: "Changeset",
      value: `${changeSet.files.length} arquivo(s) alterado(s)`,
      detail: publicDetail(`${changeSet.baseSha} → ${changeSet.headSha}`),
      tone: "neutral",
      findingIdentity: null,
    },
    {
      id: "surface",
      kind: "surface",
      label: "Superfície",
      value: surface,
      detail: category ? path || null : null,
      tone: surface === undetermined ? "neutral" : signalTone(primaryRule),
      findingIdentity,
    },
    {
      id: "signal",
      kind: "signal",
      label: "Sinal",
      value: primaryFinding
        ? publicText(`${primaryFinding.title} ${lifecycleLabels[primaryFinding.lifecycle]}`) || undetermined
        : undetermined,
      detail: primaryFinding
        ? publicDetail(`${primaryFinding.severity}${primaryFinding.confidence ? ` · ${primaryFinding.confidence}` : ""}`)
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
      value: verdict,
      detail: publicDetail(decision.summary),
      tone: verdictTone(decision.outcome),
      findingIdentity,
    },
  ];

  return { nodes, selectedNodeId: "signal" };
}

function ruleValue(rule: GateViolation | null): string {
  if (!rule) return "Nenhuma regra acionada";
  const label = rule.decision === "block" ? "Bloquear" : "Revisar";
  return publicText(`${label} ${rule.reason}`) || label;
}

function publicText(value: string): string {
  return redactPublicText(value).trim();
}

function publicDetail(value: string): string | null {
  return publicText(value) || null;
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
