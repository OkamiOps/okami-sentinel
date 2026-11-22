import type { ScopedMessages } from "./scoped";

type Key =
  | "title" | "note" | "graphify" | "codeContext" | "flows" | "issues" | "noIssues" | "inconclusive" | "skipped-budget" | "failed"
  | "reused" | "spent" | "avoided" | "budget" | "unavailable" | "loading" | "error" | "retry" | "empty" | "steps" | "findings"
  | "noFindings" | "missing" | "claim" | "impact" | "citations" | "invalid" | "downgraded" | "confirmed" | "snapshotMissing"
  | "k.authorization" | "k.state-transition" | "k.workflow-bypass" | "k.limits-and-quotas" | "k.pricing-and-amounts"
  | "k.idempotency-and-races" | "k.data-integrity" | "k.other";

const en: Record<Key, string> = {
  title: "Business rules and workflows (AI)",
  note: "Independent of SAST alerts: the AI reviews server-selected code flows for business-rule, workflow and state flaws. A finding only stands when its cited lines exist in the scan snapshot; unchanged flows reuse earlier analyses.",
  graphify: "flows from Graphify", codeContext: "flows from code context", flows: "Flows", issues: "With issues", noIssues: "No issues",
  inconclusive: "Inconclusive", "skipped-budget": "Skipped (budget)", failed: "Failed", reused: "Reused", spent: "AI cost",
  avoided: "cost avoided by reuse", budget: "budget", unavailable: "unavailable", loading: "Loading business-logic review…",
  error: "Could not load the business-logic review.", retry: "Retry", empty: "No business flows were selected for this scan.",
  steps: "Flow steps", findings: "Findings", noFindings: "No business-rule issue found in this flow.", missing: "Missing evidence",
  claim: "Claim", impact: "Impact", citations: "Cited source", invalid: "Invalid citation", downgraded: "Uncited",
  confirmed: "Cited", snapshotMissing: "The scan snapshot is unavailable; citations could not be verified.",
  "k.authorization": "Authorization", "k.state-transition": "State transition", "k.workflow-bypass": "Workflow bypass",
  "k.limits-and-quotas": "Limits and quotas", "k.pricing-and-amounts": "Prices and amounts", "k.idempotency-and-races": "Idempotency and races",
  "k.data-integrity": "Data integrity", "k.other": "Other",
};

export const businessLogicMessages: ScopedMessages<Key> = {
  "pt-BR": {
    title: "Regras de negócio e fluxos (IA)",
    note: "Independe de alertas do SAST: a IA revisa fluxos de código selecionados pelo servidor em busca de falhas de regra de negócio, workflow e estado. Um achado só vale com linhas citadas que existem no snapshot do scan; fluxos sem mudança reaproveitam análises anteriores.",
    graphify: "fluxos do Graphify", codeContext: "fluxos do contexto de código", flows: "Fluxos", issues: "Com problemas", noIssues: "Sem problemas",
    inconclusive: "Inconclusivo", "skipped-budget": "Pulado (orçamento)", failed: "Falhou", reused: "Reaproveitado", spent: "custo de IA",
    avoided: "custo evitado por reuso", budget: "orçamento", unavailable: "indisponível", loading: "Carregando revisão de regras de negócio…",
    error: "Não foi possível carregar a revisão de regras de negócio.", retry: "Tentar novamente", empty: "Nenhum fluxo de negócio foi selecionado neste scan.",
    steps: "Passos do fluxo", findings: "Achados", noFindings: "Nenhum problema de regra de negócio neste fluxo.", missing: "Evidência faltante",
    claim: "Afirmação", impact: "Impacto", citations: "Trechos citados", invalid: "Citação inválida", downgraded: "Sem citação válida",
    confirmed: "Citado", snapshotMissing: "O snapshot do scan não está disponível; as citações não puderam ser verificadas.",
    "k.authorization": "Autorização", "k.state-transition": "Transição de estado", "k.workflow-bypass": "Bypass de workflow",
    "k.limits-and-quotas": "Limites e cotas", "k.pricing-and-amounts": "Preços e valores", "k.idempotency-and-races": "Idempotência e concorrência",
    "k.data-integrity": "Integridade de dados", "k.other": "Outro",
  },
  en, es: en, de: en, fr: en,
};
