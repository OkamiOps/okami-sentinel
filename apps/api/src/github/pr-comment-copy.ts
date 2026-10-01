import type { GateOutcome, GuardrailPrCommentLocale, Severity } from "@csb/shared";

/**
 * Every word the pull-request comment says, in the five languages the interface
 * ships. The comment is read by the pull request's author, who is not necessarily
 * the operator looking at the console, so the language is the repository's setting
 * and not the session's.
 *
 * Severity names stay as their codes (`critical`, `high`, …): they are the same
 * five words GitHub, the console and the artifact already use, and translating
 * them would make the table stop matching everything else that names a severity.
 */
export interface PrCommentCopy {
  verdict: Record<GateOutcome, string>;
  severity: Record<Severity, string>;
  columnSummary: string;
  columnValue: string;
  newFindingsLabel: string;
  fixedLabel: string;
  baselineLabel: string;
  costLabel: string;
  durationLabel: string;
  commitLabel: string;
  modelLabel: string;
  newFindingsHeading: string;
  columnSeverity: string;
  columnFinding: string;
  columnLocation: string;
  viewFinding: string;
  more: (count: number) => string;
  pathWithheld: string;
  none: string;
  baselineAbsent: string;
  baselineIncompatible: Record<"default" | "scan_lineage" | "coverage" | "policy_schema", string>;
  informational: string;
  gateLink: string;
  noNewFindings: string;
}

export const PR_COMMENT_COPY: Record<GuardrailPrCommentLocale, PrCommentCopy> = {
  "pt-BR": {
    verdict: {
      blocked: "BLOQUEADO",
      warning: "AVISO",
      pass: "APROVADO",
      bootstrap: "REVISÃO",
      no_changes: "SEM MUDANÇAS",
      error: "ERRO",
    },
    severity: {
      critical: "Crítico",
      high: "Alto",
      medium: "Médio",
      low: "Baixo",
      info: "Informativo",
      unknown: "Desconhecido",
    },
    columnSummary: "Resumo",
    columnValue: "Valor",
    newFindingsLabel: "Novos achados",
    fixedLabel: "Corrigidos neste PR",
    baselineLabel: "Baseline",
    costLabel: "Custo",
    durationLabel: "Duração",
    commitLabel: "Commit",
    modelLabel: "Modelo",
    newFindingsHeading: "Novos achados",
    columnSeverity: "Severidade",
    columnFinding: "Achado",
    columnLocation: "Local",
    viewFinding: "Ver",
    more: (count) => `+${count} mais no Sentinel`,
    pathWithheld: "caminho omitido",
    none: "—",
    baselineAbsent: "nenhuma ainda — os achados são relatados sem comparação",
    baselineIncompatible: {
      default: "não comparável com este scan — os achados valem; a comparação, não",
      scan_lineage: "não comparável — construída com outro modelo, esforço ou modo (scan_lineage)",
      coverage: "não comparável — cobriu um conjunto de arquivos diferente (coverage)",
      policy_schema: "não comparável — avaliada com outro esquema de política (policy_schema)",
    },
    informational: "Este check é informativo: ele relata o que mudou e não bloqueia o merge por conta própria.",
    gateLink: "Ver o gate completo no Sentinel",
    noNewFindings: "Nenhum achado novo neste pull request.",
  },
  en: {
    verdict: {
      blocked: "BLOCKED",
      warning: "WARNING",
      pass: "APPROVED",
      bootstrap: "REVIEW",
      no_changes: "NO CHANGES",
      error: "ERROR",
    },
    severity: {
      critical: "Critical",
      high: "High",
      medium: "Medium",
      low: "Low",
      info: "Info",
      unknown: "Unknown",
    },
    columnSummary: "Summary",
    columnValue: "Value",
    newFindingsLabel: "New findings",
    fixedLabel: "Fixed by this PR",
    baselineLabel: "Baseline",
    costLabel: "Cost",
    durationLabel: "Duration",
    commitLabel: "Commit",
    modelLabel: "Model",
    newFindingsHeading: "New findings",
    columnSeverity: "Severity",
    columnFinding: "Finding",
    columnLocation: "Location",
    viewFinding: "View",
    more: (count) => `+${count} more in Sentinel`,
    pathWithheld: "path withheld",
    none: "—",
    baselineAbsent: "none yet — findings are reported without comparison",
    baselineIncompatible: {
      default: "not comparable with this scan — the findings stand, the comparison does not",
      scan_lineage: "not comparable — built with a different model, effort or mode (scan_lineage)",
      coverage: "not comparable — covered a different set of files (coverage)",
      policy_schema: "not comparable — evaluated under a different policy schema (policy_schema)",
    },
    informational: "This check is informational: it reports what changed and does not block the merge on its own.",
    gateLink: "View the full gate in Sentinel",
    noNewFindings: "No new findings in this pull request.",
  },
  es: {
    verdict: {
      blocked: "BLOQUEADO",
      warning: "AVISO",
      pass: "APROBADO",
      bootstrap: "REVISIÓN",
      no_changes: "SIN CAMBIOS",
      error: "ERROR",
    },
    severity: {
      critical: "Crítico",
      high: "Alto",
      medium: "Medio",
      low: "Bajo",
      info: "Informativo",
      unknown: "Desconocido",
    },
    columnSummary: "Resumen",
    columnValue: "Valor",
    newFindingsLabel: "Hallazgos nuevos",
    fixedLabel: "Corregidos en este PR",
    baselineLabel: "Baseline",
    costLabel: "Costo",
    durationLabel: "Duración",
    commitLabel: "Commit",
    modelLabel: "Modelo",
    newFindingsHeading: "Hallazgos nuevos",
    columnSeverity: "Severidad",
    columnFinding: "Hallazgo",
    columnLocation: "Ubicación",
    viewFinding: "Ver",
    more: (count) => `+${count} más en Sentinel`,
    pathWithheld: "ruta omitida",
    none: "—",
    baselineAbsent: "ninguna todavía — los hallazgos se informan sin comparación",
    baselineIncompatible: {
      default: "no comparable con este scan — los hallazgos valen; la comparación, no",
      scan_lineage: "no comparable — construida con otro modelo, esfuerzo o modo (scan_lineage)",
      coverage: "no comparable — cubrió un conjunto de archivos distinto (coverage)",
      policy_schema: "no comparable — evaluada con otro esquema de política (policy_schema)",
    },
    informational: "Este check es informativo: informa lo que cambió y no bloquea el merge por sí mismo.",
    gateLink: "Ver el gate completo en Sentinel",
    noNewFindings: "Sin hallazgos nuevos en este pull request.",
  },
  de: {
    verdict: {
      blocked: "BLOCKIERT",
      warning: "WARNUNG",
      pass: "GENEHMIGT",
      bootstrap: "PRÜFUNG",
      no_changes: "KEINE ÄNDERUNGEN",
      error: "FEHLER",
    },
    severity: {
      critical: "Kritisch",
      high: "Hoch",
      medium: "Mittel",
      low: "Niedrig",
      info: "Hinweis",
      unknown: "Unbekannt",
    },
    columnSummary: "Zusammenfassung",
    columnValue: "Wert",
    newFindingsLabel: "Neue Funde",
    fixedLabel: "Von diesem PR behoben",
    baselineLabel: "Baseline",
    costLabel: "Kosten",
    durationLabel: "Dauer",
    commitLabel: "Commit",
    modelLabel: "Modell",
    newFindingsHeading: "Neue Funde",
    columnSeverity: "Schweregrad",
    columnFinding: "Fund",
    columnLocation: "Ort",
    viewFinding: "Ansehen",
    more: (count) => `+${count} weitere in Sentinel`,
    pathWithheld: "Pfad zurückgehalten",
    none: "—",
    baselineAbsent: "noch keine — die Funde werden ohne Vergleich gemeldet",
    baselineIncompatible: {
      default: "nicht vergleichbar mit diesem Scan — die Funde gelten, der Vergleich nicht",
      scan_lineage: "nicht vergleichbar — mit anderem Modell, Aufwand oder Modus erstellt (scan_lineage)",
      coverage: "nicht vergleichbar — deckte einen anderen Dateisatz ab (coverage)",
      policy_schema: "nicht vergleichbar — unter einem anderen Policy-Schema bewertet (policy_schema)",
    },
    informational: "Dieser Check ist informativ: er meldet, was sich geändert hat, und blockiert den Merge nicht von sich aus.",
    gateLink: "Das vollständige Gate in Sentinel ansehen",
    noNewFindings: "Keine neuen Funde in diesem Pull Request.",
  },
  fr: {
    verdict: {
      blocked: "BLOQUÉ",
      warning: "AVERTISSEMENT",
      pass: "APPROUVÉ",
      bootstrap: "REVUE",
      no_changes: "AUCUN CHANGEMENT",
      error: "ERREUR",
    },
    severity: {
      critical: "Critique",
      high: "Élevé",
      medium: "Moyen",
      low: "Faible",
      info: "Information",
      unknown: "Inconnu",
    },
    columnSummary: "Résumé",
    columnValue: "Valeur",
    newFindingsLabel: "Nouveaux constats",
    fixedLabel: "Corrigés par cette PR",
    baselineLabel: "Baseline",
    costLabel: "Coût",
    durationLabel: "Durée",
    commitLabel: "Commit",
    modelLabel: "Modèle",
    newFindingsHeading: "Nouveaux constats",
    columnSeverity: "Sévérité",
    columnFinding: "Constat",
    columnLocation: "Emplacement",
    viewFinding: "Voir",
    more: (count) => `+${count} de plus dans Sentinel`,
    pathWithheld: "chemin retenu",
    none: "—",
    baselineAbsent: "aucune pour l’instant — les constats sont rapportés sans comparaison",
    baselineIncompatible: {
      default: "non comparable à ce scan — les constats tiennent, la comparaison non",
      scan_lineage: "non comparable — construite avec un autre modèle, effort ou mode (scan_lineage)",
      coverage: "non comparable — couvrait un autre ensemble de fichiers (coverage)",
      policy_schema: "non comparable — évaluée sous un autre schéma de politique (policy_schema)",
    },
    informational: "Ce check est informatif : il rapporte ce qui a changé et ne bloque pas la fusion de lui-même.",
    gateLink: "Voir le gate complet dans Sentinel",
    noNewFindings: "Aucun nouveau constat dans cette pull request.",
  },
};
