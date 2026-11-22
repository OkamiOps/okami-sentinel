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

const es: Record<Key, string> = {
  title: "Reglas de negocio y flujos (IA)",
  note: "Independiente de las alertas SAST: la IA revisa flujos de código seleccionados por el servidor en busca de fallos de reglas de negocio, workflow y estado. Un hallazgo solo cuenta si sus líneas citadas existen en el snapshot del scan; los flujos sin cambios reutilizan análisis anteriores.",
  graphify: "flujos de Graphify", codeContext: "flujos del contexto de código", flows: "Flujos", issues: "Con problemas", noIssues: "Sin problemas",
  inconclusive: "No concluyente", "skipped-budget": "Omitido (presupuesto)", failed: "Falló", reused: "Reutilizado", spent: "coste de IA",
  avoided: "coste evitado por reutilización", budget: "presupuesto", unavailable: "no disponible", loading: "Cargando revisión de reglas de negocio…",
  error: "No se pudo cargar la revisión de reglas de negocio.", retry: "Reintentar", empty: "No se seleccionó ningún flujo de negocio en este scan.",
  steps: "Pasos del flujo", findings: "Hallazgos", noFindings: "Ningún problema de reglas de negocio en este flujo.", missing: "Evidencia faltante",
  claim: "Afirmación", impact: "Impacto", citations: "Fragmentos citados", invalid: "Cita no válida", downgraded: "Sin cita válida",
  confirmed: "Citado", snapshotMissing: "El snapshot del scan no está disponible; no se pudieron verificar las citas.",
  "k.authorization": "Autorización", "k.state-transition": "Transición de estado", "k.workflow-bypass": "Elusión del workflow",
  "k.limits-and-quotas": "Límites y cuotas", "k.pricing-and-amounts": "Precios e importes", "k.idempotency-and-races": "Idempotencia y concurrencia",
  "k.data-integrity": "Integridad de datos", "k.other": "Otro",
};

const de: Record<Key, string> = {
  title: "Geschäftsregeln und Abläufe (KI)",
  note: "Unabhängig von SAST-Warnungen: Die KI prüft vom Server ausgewählte Code-Abläufe auf Fehler in Geschäftsregeln, Workflows und Zuständen. Ein Befund gilt nur mit zitierten Zeilen, die im Scan-Snapshot existieren; unveränderte Abläufe verwenden frühere Analysen wieder.",
  graphify: "Abläufe aus Graphify", codeContext: "Abläufe aus dem Code-Kontext", flows: "Abläufe", issues: "Mit Problemen", noIssues: "Ohne Probleme",
  inconclusive: "Nicht eindeutig", "skipped-budget": "Übersprungen (Budget)", failed: "Fehlgeschlagen", reused: "Wiederverwendet", spent: "KI-Kosten",
  avoided: "durch Wiederverwendung eingespart", budget: "Budget", unavailable: "nicht verfügbar", loading: "Geschäftsregel-Prüfung wird geladen…",
  error: "Die Geschäftsregel-Prüfung konnte nicht geladen werden.", retry: "Erneut versuchen", empty: "In diesem Scan wurde kein Geschäftsablauf ausgewählt.",
  steps: "Ablaufschritte", findings: "Befunde", noFindings: "Kein Geschäftsregel-Problem in diesem Ablauf.", missing: "Fehlende Belege",
  claim: "Aussage", impact: "Auswirkung", citations: "Zitierte Stellen", invalid: "Ungültiges Zitat", downgraded: "Ohne gültiges Zitat",
  confirmed: "Zitiert", snapshotMissing: "Der Scan-Snapshot ist nicht verfügbar; Zitate konnten nicht geprüft werden.",
  "k.authorization": "Autorisierung", "k.state-transition": "Zustandsübergang", "k.workflow-bypass": "Workflow-Umgehung",
  "k.limits-and-quotas": "Limits und Kontingente", "k.pricing-and-amounts": "Preise und Beträge", "k.idempotency-and-races": "Idempotenz und Race Conditions",
  "k.data-integrity": "Datenintegrität", "k.other": "Sonstiges",
};

const fr: Record<Key, string> = {
  title: "Règles métier et flux (IA)",
  note: "Indépendant des alertes SAST : l'IA examine des flux de code sélectionnés par le serveur pour trouver des failles de règles métier, de workflow et d'état. Un constat n'est retenu que si ses lignes citées existent dans le snapshot du scan ; les flux inchangés réutilisent les analyses précédentes.",
  graphify: "flux issus de Graphify", codeContext: "flux issus du contexte de code", flows: "Flux", issues: "Avec problèmes", noIssues: "Sans problème",
  inconclusive: "Non concluant", "skipped-budget": "Ignoré (budget)", failed: "Échec", reused: "Réutilisé", spent: "coût IA",
  avoided: "coût évité par réutilisation", budget: "budget", unavailable: "indisponible", loading: "Chargement de la revue des règles métier…",
  error: "Impossible de charger la revue des règles métier.", retry: "Réessayer", empty: "Aucun flux métier n'a été sélectionné pour ce scan.",
  steps: "Étapes du flux", findings: "Constats", noFindings: "Aucun problème de règle métier dans ce flux.", missing: "Preuves manquantes",
  claim: "Affirmation", impact: "Impact", citations: "Extraits cités", invalid: "Citation invalide", downgraded: "Sans citation valide",
  confirmed: "Cité", snapshotMissing: "Le snapshot du scan n'est pas disponible ; les citations n'ont pas pu être vérifiées.",
  "k.authorization": "Autorisation", "k.state-transition": "Transition d'état", "k.workflow-bypass": "Contournement du workflow",
  "k.limits-and-quotas": "Limites et quotas", "k.pricing-and-amounts": "Prix et montants", "k.idempotency-and-races": "Idempotence et concurrence",
  "k.data-integrity": "Intégrité des données", "k.other": "Autre",
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
  en, es, de, fr,
};
