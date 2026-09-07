export const compareReportPtBR = {
  "compareReport.documentTitle":
    "{count} scans · relatório comparativo OKAMI Sentinel",
  "compareReport.documentTitleEmpty": "Relatório comparativo OKAMI Sentinel",
  "compareReport.invalidSelection":
    "Selecione de 2 a 6 scans antes de emitir o relatório comparativo.",
  "compareReport.loading": "Consolidando comparação…",
  "compareReport.pdf": "PDF",
  "compareReport.missingModel": "modelo",
  "compareReport.missingEffort": "esforço",
  "compareReport.missingMode": "modo",
  "compareReport.errorTitle": "Não foi possível montar o relatório comparativo",
  "compareReport.staleTitle": "Resultado anterior preservado",
  "compareReport.staleDescription":
    "A atualização falhou. O relatório exibido pode estar desatualizado; tente atualizar novamente.",
  "compareReport.toolbarSummary": "{count} scans / {objective}",
  "compareReport.coverKicker":
    "Inteligência de múltiplas execuções / dossiê de decisão",
  "compareReport.coverTitleLead": "Relatório comparativo",
  "compareReport.coverTitleTail": "de scans de segurança",
  "compareReport.coverDescription":
    "Comparação de cobertura reportada, custo operacional e divergência de evidências entre até seis execuções.",
  "compareReport.baselineLabel": "BASELINE",
  "compareReport.comparisonSetLabel": "CONJUNTO COMPARADO",
  "compareReport.decisionObjectiveLabel": "OBJETIVO DE DECISÃO",
  "compareReport.reportIdLabel": "ID DO RELATÓRIO",
  "compareReport.comparisonSetValue": "{scans} scans · {candidates} candidatos",
  "compareReport.confidentialEvidence": "Confidencial / evidência local",
  "compareReport.partialInputs": "{count} entradas parciais",
  "compareReport.winnerKicker": "Vencedor sob objetivo explícito",
  "compareReport.winnerSummary":
    "Lidera no critério {objective}: {description}. O ranking mede resultados reportados, custo e duração; não mede precisão sem triagem.",
  "compareReport.partialResultTitle": "Resultado parcial:",
  "compareReport.partialResultDescription":
    "a execução vencedora foi interrompida após preservar findings. Sua cobertura não foi concluída.",
  "compareReport.completeResultTitle": "Execução concluída:",
  "compareReport.completeResultDescription":
    "o motor encerrou o fluxo, mas os findings ainda dependem de triagem técnica.",
  "compareReport.scansMetric": "SCANS",
  "compareReport.partialMetric": "PARCIAL",
  "compareReport.totalCostMetric": "CUSTO TOTAL",
  "compareReport.knownCostMetric": "CUSTO CONHECIDO",
  "compareReport.objectiveMetric": "OBJETIVO",
  "compareReport.readingLimitTitle": "Limite da leitura:",
  "compareReport.readingLimitDescription":
    "mais findings não prova maior precisão; menos findings não prova correção. Confirme uma amostra antes da decisão.",
  "compareReport.coverageCostSeverity": "Cobertura, custo e severidade",
  "compareReport.costCoverageKicker":
    "Custo × cobertura reportada / tamanho do nó = High+",
  "compareReport.severityProfileKicker":
    "Perfil de severidade / volume absoluto",
  "compareReport.noComparableCost":
    "Nenhuma execução deste recorte publicou uma estimativa USD comparável. Uso de franquia da assinatura não é tratado como custo zero.",
  "compareReport.costCoverageAria": "Gráfico de custo por cobertura reportada",
  "compareReport.lowCostAxis": "BAIXO CUSTO",
  "compareReport.highCostAxis": "ALTO CUSTO",
  "compareReport.moreFindingsAxis": "MAIS FINDINGS",
  "compareReport.rankingExecution": "Execução",
  "compareReport.rankingScore": "Pontuação",
  "compareReport.rankingCost": "Custo",
  "compareReport.rankingCostPerFinding": "$/finding",
  "compareReport.totalValue": "{count} total",
  "compareReport.vsBaseline": "{count} vs baseline",
  "compareReport.scoreMetric": "Pontuação",
  "compareReport.costMetric": "Custo",
  "compareReport.pairTitle": "Par {number} / {profile}",
  "compareReport.candidateRole": "CANDIDATO {number}",
  "compareReport.deltaTotal": "Δ TOTAL",
  "compareReport.deltaHigh": "Δ HIGH+",
  "compareReport.deltaCost": "Δ CUSTO",
  "compareReport.agreement": "CONCORDÂNCIA",
  "compareReport.operationalReading": "Leitura operacional",
  "compareReport.directionSame": "reportou o mesmo volume total",
  "compareReport.directionMore": "reportou {count} findings a mais",
  "compareReport.directionFewer": "reportou {count} findings a menos",
  "compareReport.operationalSummary":
    "O candidato {direction}, com {highDelta} High+ e custo {costDelta} contra o baseline. O custo unitário mudou de {baselineFindingCost} para {candidateFindingCost} por finding e de {baselineHighCost} para {candidateHighCost} por High+.",
  "compareReport.priorityDivergences":
    "Divergências prioritárias / detalhe técnico",
  "compareReport.noDivergences":
    "Nenhuma divergência de presença ou severidade neste par.",
  "compareReport.partialInputTitle": "Entrada parcial:",
  "compareReport.partialInputDescription":
    "pelo menos um scan foi interrompido depois de produzir findings; os números não representam cobertura concluída.",
  "compareReport.partialBadge": "parcial",
  "compareReport.statusQueued": "na fila",
  "compareReport.statusRunning": "em execução",
  "compareReport.statusCompleted": "concluído",
  "compareReport.statusFailed": "falhou",
  "compareReport.statusCancelled": "cancelado",
  "compareReport.statusIncomplete": "incompleto",
  "compareReport.totalMetric": "Total",
  "compareReport.costPerFindingMetric": "$/F",
  "compareReport.noTechnicalSummary":
    "Sem resumo técnico preservado para esta ocorrência.",
  "compareReport.decisionHandoff": "Encaminhamento da decisão",
  "compareReport.conclusionTitle":
    "O melhor scan depende do objetivo. A verdade depende da triagem.",
  "compareReport.conclusionDescription":
    "Este comparativo permite escolher eficiência, cobertura ou velocidade sem misturar os critérios. Para medir qualidade real, confirme findings e estabeleça ground truth.",
  "compareReport.nextActions": "Próximas ações",
  "compareReport.nextActionConfirmSample": "Confirmar amostra compartilhada",
  "compareReport.nextActionReviewSignals": "Revisar sinais exclusivos",
  "compareReport.nextActionNormalize": "Normalizar perfil e escopo",
  "compareReport.nextActionRecordFalsePositives": "Registrar falsos positivos",
  "compareReport.nextActionRepeat": "Repetir e comparar novamente",
} as const;

export const compareReportEn: Record<keyof typeof compareReportPtBR, string> = {
  "compareReport.documentTitle":
    "{count} scans · OKAMI Sentinel comparison report",
  "compareReport.documentTitleEmpty": "OKAMI Sentinel comparison report",
  "compareReport.invalidSelection":
    "Select 2 to 6 scans before generating the comparison report.",
  "compareReport.loading": "Consolidating comparison…",
  "compareReport.pdf": "PDF",
  "compareReport.missingModel": "model",
  "compareReport.missingEffort": "effort",
  "compareReport.missingMode": "mode",
  "compareReport.errorTitle": "The comparison report could not be generated",
  "compareReport.staleTitle": "Previous result preserved",
  "compareReport.staleDescription":
    "The refresh failed. The report on screen may be out of date; try refreshing again.",
  "compareReport.toolbarSummary": "{count} scans / {objective}",
  "compareReport.coverKicker": "Multi-run intelligence / decision dossier",
  "compareReport.coverTitleLead": "Security scan",
  "compareReport.coverTitleTail": "comparison report",
  "compareReport.coverDescription":
    "Comparison of reported coverage, operating cost, and evidence divergence across up to six runs.",
  "compareReport.baselineLabel": "BASELINE",
  "compareReport.comparisonSetLabel": "COMPARISON SET",
  "compareReport.decisionObjectiveLabel": "DECISION OBJECTIVE",
  "compareReport.reportIdLabel": "REPORT ID",
  "compareReport.comparisonSetValue": "{scans} scans · {candidates} candidates",
  "compareReport.confidentialEvidence": "Confidential / local evidence",
  "compareReport.partialInputs": "{count} partial inputs",
  "compareReport.winnerKicker": "Winner under explicit objective",
  "compareReport.winnerSummary":
    "Leads on the {objective} criterion: {description}. The ranking measures reported results, cost, and duration; it does not measure accuracy without triage.",
  "compareReport.partialResultTitle": "Partial result:",
  "compareReport.partialResultDescription":
    "the winning run was interrupted after preserving findings. Its coverage was not completed.",
  "compareReport.completeResultTitle": "Completed run:",
  "compareReport.completeResultDescription":
    "the engine completed the flow, but findings still require technical triage.",
  "compareReport.scansMetric": "SCANS",
  "compareReport.partialMetric": "PARTIAL",
  "compareReport.totalCostMetric": "TOTAL COST",
  "compareReport.knownCostMetric": "KNOWN COST",
  "compareReport.objectiveMetric": "OBJECTIVE",
  "compareReport.readingLimitTitle": "Reading limit:",
  "compareReport.readingLimitDescription":
    "more findings do not prove greater accuracy; fewer findings do not prove correctness. Confirm a sample before deciding.",
  "compareReport.coverageCostSeverity": "Coverage, cost, and severity",
  "compareReport.costCoverageKicker":
    "Cost × reported coverage / node size = High+",
  "compareReport.severityProfileKicker": "Severity profile / absolute volume",
  "compareReport.noComparableCost":
    "No run in this selection published a comparable USD estimate. Subscription allowance is not treated as zero cost.",
  "compareReport.costCoverageAria": "Cost by reported coverage chart",
  "compareReport.lowCostAxis": "LOW COST",
  "compareReport.highCostAxis": "HIGH COST",
  "compareReport.moreFindingsAxis": "MORE FINDINGS",
  "compareReport.rankingExecution": "Execution",
  "compareReport.rankingScore": "Score",
  "compareReport.rankingCost": "Cost",
  "compareReport.rankingCostPerFinding": "$/finding",
  "compareReport.totalValue": "{count} total",
  "compareReport.vsBaseline": "{count} vs baseline",
  "compareReport.scoreMetric": "Score",
  "compareReport.costMetric": "Cost",
  "compareReport.pairTitle": "Pair {number} / {profile}",
  "compareReport.candidateRole": "CANDIDATE {number}",
  "compareReport.deltaTotal": "Δ TOTAL",
  "compareReport.deltaHigh": "Δ HIGH+",
  "compareReport.deltaCost": "Δ COST",
  "compareReport.agreement": "AGREEMENT",
  "compareReport.operationalReading": "Operational reading",
  "compareReport.directionSame": "reported the same total volume",
  "compareReport.directionMore": "reported {count} more findings",
  "compareReport.directionFewer": "reported {count} fewer findings",
  "compareReport.operationalSummary":
    "The candidate {direction}, with {highDelta} High+ and cost {costDelta} against the baseline. Unit cost changed from {baselineFindingCost} to {candidateFindingCost} per finding and from {baselineHighCost} to {candidateHighCost} per High+.",
  "compareReport.priorityDivergences":
    "Priority divergences / technical detail",
  "compareReport.noDivergences":
    "There is no presence or severity divergence in this pair.",
  "compareReport.partialInputTitle": "Partial input:",
  "compareReport.partialInputDescription":
    "at least one scan was interrupted after producing findings; the figures do not represent completed coverage.",
  "compareReport.partialBadge": "partial",
  "compareReport.statusQueued": "queued",
  "compareReport.statusRunning": "running",
  "compareReport.statusCompleted": "completed",
  "compareReport.statusFailed": "failed",
  "compareReport.statusCancelled": "cancelled",
  "compareReport.statusIncomplete": "incomplete",
  "compareReport.totalMetric": "Total",
  "compareReport.costPerFindingMetric": "$/F",
  "compareReport.noTechnicalSummary":
    "No technical summary was preserved for this occurrence.",
  "compareReport.decisionHandoff": "Decision handoff",
  "compareReport.conclusionTitle":
    "The best scan depends on the objective. The truth depends on triage.",
  "compareReport.conclusionDescription":
    "This comparison lets you choose efficiency, coverage, or speed without mixing the criteria. To measure real quality, confirm findings and establish ground truth.",
  "compareReport.nextActions": "Next actions",
  "compareReport.nextActionConfirmSample": "Confirm the shared sample",
  "compareReport.nextActionReviewSignals": "Review exclusive signals",
  "compareReport.nextActionNormalize": "Normalize profile and scope",
  "compareReport.nextActionRecordFalsePositives": "Record false positives",
  "compareReport.nextActionRepeat": "Repeat and compare again",
};

export const compareReportEs: Record<keyof typeof compareReportPtBR, string> = {
  "compareReport.documentTitle":
    "{count} scans · informe comparativo de OKAMI Sentinel",
  "compareReport.documentTitleEmpty": "Informe comparativo de OKAMI Sentinel",
  "compareReport.invalidSelection":
    "Selecciona de 2 a 6 scans antes de generar el informe comparativo.",
  "compareReport.loading": "Consolidando la comparación…",
  "compareReport.pdf": "PDF",
  "compareReport.missingModel": "modelo",
  "compareReport.missingEffort": "esfuerzo",
  "compareReport.missingMode": "modo",
  "compareReport.errorTitle": "No se pudo generar el informe comparativo",
  "compareReport.staleTitle": "Resultado anterior conservado",
  "compareReport.staleDescription":
    "La actualización falló. El informe mostrado puede estar desactualizado; intenta actualizarlo de nuevo.",
  "compareReport.toolbarSummary": "{count} scans / {objective}",
  "compareReport.coverKicker":
    "Inteligencia de múltiples ejecuciones / dossier de decisión",
  "compareReport.coverTitleLead": "Informe comparativo",
  "compareReport.coverTitleTail": "de scans de seguridad",
  "compareReport.coverDescription":
    "Comparación de cobertura reportada, coste operativo y divergencia de evidencias entre hasta seis ejecuciones.",
  "compareReport.baselineLabel": "BASELINE",
  "compareReport.comparisonSetLabel": "CONJUNTO COMPARADO",
  "compareReport.decisionObjectiveLabel": "OBJETIVO DE DECISIÓN",
  "compareReport.reportIdLabel": "ID DEL INFORME",
  "compareReport.comparisonSetValue": "{scans} scans · {candidates} candidatos",
  "compareReport.confidentialEvidence": "Confidencial / evidencia local",
  "compareReport.partialInputs": "{count} entradas parciales",
  "compareReport.winnerKicker": "Ganador según un objetivo explícito",
  "compareReport.winnerSummary":
    "Lidera en el criterio {objective}: {description}. El ranking mide resultados reportados, coste y duración; no mide precisión sin triaje.",
  "compareReport.partialResultTitle": "Resultado parcial:",
  "compareReport.partialResultDescription":
    "la ejecución ganadora se interrumpió después de preservar findings. Su cobertura no se completó.",
  "compareReport.completeResultTitle": "Ejecución completada:",
  "compareReport.completeResultDescription":
    "el motor terminó el flujo, pero los findings aún requieren triaje técnico.",
  "compareReport.scansMetric": "SCANS",
  "compareReport.partialMetric": "PARCIAL",
  "compareReport.totalCostMetric": "COSTE TOTAL",
  "compareReport.knownCostMetric": "COSTE CONOCIDO",
  "compareReport.objectiveMetric": "OBJETIVO",
  "compareReport.readingLimitTitle": "Límite de lectura:",
  "compareReport.readingLimitDescription":
    "más findings no prueban mayor precisión; menos findings no prueban corrección. Confirma una muestra antes de decidir.",
  "compareReport.coverageCostSeverity": "Cobertura, coste y severidad",
  "compareReport.costCoverageKicker":
    "Coste × cobertura reportada / tamaño del nodo = High+",
  "compareReport.severityProfileKicker":
    "Perfil de severidad / volumen absoluto",
  "compareReport.noComparableCost":
    "Ninguna ejecución de esta selección publicó una estimación USD comparable. La franquicia de suscripción no se trata como coste cero.",
  "compareReport.costCoverageAria": "Gráfico de coste por cobertura reportada",
  "compareReport.lowCostAxis": "COSTE BAJO",
  "compareReport.highCostAxis": "COSTE ALTO",
  "compareReport.moreFindingsAxis": "MÁS FINDINGS",
  "compareReport.rankingExecution": "Ejecución",
  "compareReport.rankingScore": "Puntuación",
  "compareReport.rankingCost": "Coste",
  "compareReport.rankingCostPerFinding": "$/finding",
  "compareReport.totalValue": "{count} total",
  "compareReport.vsBaseline": "{count} frente al baseline",
  "compareReport.scoreMetric": "Puntuación",
  "compareReport.costMetric": "Coste",
  "compareReport.pairTitle": "Par {number} / {profile}",
  "compareReport.candidateRole": "CANDIDATO {number}",
  "compareReport.deltaTotal": "Δ TOTAL",
  "compareReport.deltaHigh": "Δ HIGH+",
  "compareReport.deltaCost": "Δ COSTE",
  "compareReport.agreement": "COINCIDENCIA",
  "compareReport.operationalReading": "Lectura operativa",
  "compareReport.directionSame": "reportó el mismo volumen total",
  "compareReport.directionMore": "reportó {count} findings más",
  "compareReport.directionFewer": "reportó {count} findings menos",
  "compareReport.operationalSummary":
    "El candidato {direction}, con {highDelta} High+ y coste {costDelta} frente al baseline. El coste unitario cambió de {baselineFindingCost} a {candidateFindingCost} por finding y de {baselineHighCost} a {candidateHighCost} por High+.",
  "compareReport.priorityDivergences":
    "Divergencias prioritarias / detalle técnico",
  "compareReport.noDivergences":
    "No hay divergencia de presencia o severidad en este par.",
  "compareReport.partialInputTitle": "Entrada parcial:",
  "compareReport.partialInputDescription":
    "al menos un scan se interrumpió después de producir findings; las cifras no representan cobertura completada.",
  "compareReport.partialBadge": "parcial",
  "compareReport.statusQueued": "en cola",
  "compareReport.statusRunning": "en ejecución",
  "compareReport.statusCompleted": "completado",
  "compareReport.statusFailed": "falló",
  "compareReport.statusCancelled": "cancelado",
  "compareReport.statusIncomplete": "incompleto",
  "compareReport.totalMetric": "Total",
  "compareReport.costPerFindingMetric": "$/F",
  "compareReport.noTechnicalSummary":
    "No se conservó ningún resumen técnico para esta ocurrencia.",
  "compareReport.decisionHandoff": "Entrega de decisión",
  "compareReport.conclusionTitle":
    "El mejor scan depende del objetivo. La verdad depende del triaje.",
  "compareReport.conclusionDescription":
    "Este comparativo permite elegir eficiencia, cobertura o velocidad sin mezclar criterios. Para medir la calidad real, confirma findings y establece ground truth.",
  "compareReport.nextActions": "Próximas acciones",
  "compareReport.nextActionConfirmSample": "Confirmar la muestra compartida",
  "compareReport.nextActionReviewSignals": "Revisar señales exclusivas",
  "compareReport.nextActionNormalize": "Normalizar perfil y alcance",
  "compareReport.nextActionRecordFalsePositives": "Registrar falsos positivos",
  "compareReport.nextActionRepeat": "Repetir y comparar de nuevo",
};

export const compareReportDe: Record<keyof typeof compareReportPtBR, string> = {
  "compareReport.documentTitle":
    "{count} Scans · OKAMI Sentinel Vergleichsbericht",
  "compareReport.documentTitleEmpty": "OKAMI Sentinel Vergleichsbericht",
  "compareReport.invalidSelection":
    "Wählen Sie 2 bis 6 Scans aus, bevor Sie den Vergleichsbericht erstellen.",
  "compareReport.loading": "Vergleich wird zusammengeführt…",
  "compareReport.pdf": "PDF",
  "compareReport.missingModel": "Modell",
  "compareReport.missingEffort": "Aufwand",
  "compareReport.missingMode": "Modus",
  "compareReport.errorTitle":
    "Der Vergleichsbericht konnte nicht erstellt werden",
  "compareReport.staleTitle": "Vorheriges Ergebnis erhalten",
  "compareReport.staleDescription":
    "Die Aktualisierung ist fehlgeschlagen. Der angezeigte Bericht kann veraltet sein; versuchen Sie es erneut.",
  "compareReport.toolbarSummary": "{count} Scans / {objective}",
  "compareReport.coverKicker":
    "Intelligenz aus mehreren Ausführungen / Entscheidungsdossier",
  "compareReport.coverTitleLead": "Vergleichsbericht",
  "compareReport.coverTitleTail": "zu Sicherheits-Scans",
  "compareReport.coverDescription":
    "Vergleich der gemeldeten Abdeckung, Betriebskosten und Evidenzabweichungen aus bis zu sechs Ausführungen.",
  "compareReport.baselineLabel": "BASELINE",
  "compareReport.comparisonSetLabel": "VERGLEICHSMENGE",
  "compareReport.decisionObjectiveLabel": "ENTSCHEIDUNGSZIEL",
  "compareReport.reportIdLabel": "BERICHT-ID",
  "compareReport.comparisonSetValue": "{scans} Scans · {candidates} Kandidaten",
  "compareReport.confidentialEvidence": "Vertraulich / lokale Evidenz",
  "compareReport.partialInputs": "{count} unvollständige Eingaben",
  "compareReport.winnerKicker": "Gewinner nach explizitem Ziel",
  "compareReport.winnerSummary":
    "Führt beim Kriterium {objective}: {description}. Das Ranking misst gemeldete Ergebnisse, Kosten und Dauer; ohne Triage misst es keine Genauigkeit.",
  "compareReport.partialResultTitle": "Teilergebnis:",
  "compareReport.partialResultDescription":
    "die gewinnende Ausführung wurde nach dem Erhalt der Findings unterbrochen. Ihre Abdeckung wurde nicht abgeschlossen.",
  "compareReport.completeResultTitle": "Abgeschlossene Ausführung:",
  "compareReport.completeResultDescription":
    "die Engine hat den Ablauf beendet, aber die Findings erfordern weiterhin technische Triage.",
  "compareReport.scansMetric": "SCANS",
  "compareReport.partialMetric": "TEILWEISE",
  "compareReport.totalCostMetric": "GESAMTKOSTEN",
  "compareReport.knownCostMetric": "BEKANNTE KOSTEN",
  "compareReport.objectiveMetric": "ZIEL",
  "compareReport.readingLimitTitle": "Grenze der Auswertung:",
  "compareReport.readingLimitDescription":
    "mehr Findings beweisen keine höhere Genauigkeit; weniger Findings beweisen keine Korrektheit. Bestätigen Sie vor der Entscheidung eine Stichprobe.",
  "compareReport.coverageCostSeverity": "Abdeckung, Kosten und Schweregrad",
  "compareReport.costCoverageKicker":
    "Kosten × gemeldete Abdeckung / Knotengröße = High+",
  "compareReport.severityProfileKicker":
    "Schweregradprofil / absolutes Volumen",
  "compareReport.noComparableCost":
    "Keine Ausführung in dieser Auswahl hat eine vergleichbare USD-Schätzung veröffentlicht. Das Abonnementkontingent wird nicht als Kosten von null behandelt.",
  "compareReport.costCoverageAria":
    "Diagramm der Kosten nach gemeldeter Abdeckung",
  "compareReport.lowCostAxis": "NIEDRIGE KOSTEN",
  "compareReport.highCostAxis": "HOHE KOSTEN",
  "compareReport.moreFindingsAxis": "MEHR FINDINGS",
  "compareReport.rankingExecution": "Ausführung",
  "compareReport.rankingScore": "Punktzahl",
  "compareReport.rankingCost": "Kosten",
  "compareReport.rankingCostPerFinding": "$/Finding",
  "compareReport.totalValue": "{count} gesamt",
  "compareReport.vsBaseline": "{count} gegenüber Baseline",
  "compareReport.scoreMetric": "Punktzahl",
  "compareReport.costMetric": "Kosten",
  "compareReport.pairTitle": "Paar {number} / {profile}",
  "compareReport.candidateRole": "KANDIDAT {number}",
  "compareReport.deltaTotal": "Δ GESAMT",
  "compareReport.deltaHigh": "Δ HIGH+",
  "compareReport.deltaCost": "Δ KOSTEN",
  "compareReport.agreement": "ÜBEREINSTIMMUNG",
  "compareReport.operationalReading": "Operative Auswertung",
  "compareReport.directionSame": "meldete dasselbe Gesamtvolumen",
  "compareReport.directionMore": "meldete {count} Findings mehr",
  "compareReport.directionFewer": "meldete {count} Findings weniger",
  "compareReport.operationalSummary":
    "Der Kandidat {direction}, mit {highDelta} High+ und Kosten von {costDelta} gegenüber der Baseline. Die Stückkosten änderten sich von {baselineFindingCost} auf {candidateFindingCost} pro Finding und von {baselineHighCost} auf {candidateHighCost} pro High+.",
  "compareReport.priorityDivergences":
    "Prioritäre Abweichungen / technische Details",
  "compareReport.noDivergences":
    "In diesem Paar gibt es keine Abweichung bei Präsenz oder Schweregrad.",
  "compareReport.partialInputTitle": "Unvollständige Eingabe:",
  "compareReport.partialInputDescription":
    "mindestens ein Scan wurde nach dem Erzeugen von Findings unterbrochen; die Werte stellen keine abgeschlossene Abdeckung dar.",
  "compareReport.partialBadge": "teilweise",
  "compareReport.statusQueued": "in Warteschlange",
  "compareReport.statusRunning": "wird ausgeführt",
  "compareReport.statusCompleted": "abgeschlossen",
  "compareReport.statusFailed": "fehlgeschlagen",
  "compareReport.statusCancelled": "abgebrochen",
  "compareReport.statusIncomplete": "unvollständig",
  "compareReport.totalMetric": "Gesamt",
  "compareReport.costPerFindingMetric": "$/F",
  "compareReport.noTechnicalSummary":
    "Für dieses Vorkommnis wurde keine technische Zusammenfassung gespeichert.",
  "compareReport.decisionHandoff": "Entscheidungsübergabe",
  "compareReport.conclusionTitle":
    "Der beste Scan hängt vom Ziel ab. Die Wahrheit hängt von der Triage ab.",
  "compareReport.conclusionDescription":
    "Dieser Vergleich erlaubt die Wahl von Effizienz, Abdeckung oder Geschwindigkeit, ohne die Kriterien zu vermischen. Um die tatsächliche Qualität zu messen, bestätigen Sie Findings und legen Sie Ground Truth fest.",
  "compareReport.nextActions": "Nächste Schritte",
  "compareReport.nextActionConfirmSample": "Gemeinsame Stichprobe bestätigen",
  "compareReport.nextActionReviewSignals": "Exklusive Signale prüfen",
  "compareReport.nextActionNormalize": "Profil und Umfang normalisieren",
  "compareReport.nextActionRecordFalsePositives": "False Positives erfassen",
  "compareReport.nextActionRepeat": "Wiederholen und erneut vergleichen",
};

export const compareReportFr: Record<keyof typeof compareReportPtBR, string> = {
  "compareReport.documentTitle":
    "{count} scans · rapport comparatif OKAMI Sentinel",
  "compareReport.documentTitleEmpty": "Rapport comparatif OKAMI Sentinel",
  "compareReport.invalidSelection":
    "Sélectionnez de 2 à 6 scans avant de générer le rapport comparatif.",
  "compareReport.loading": "Consolidation de la comparaison…",
  "compareReport.pdf": "PDF",
  "compareReport.missingModel": "modèle",
  "compareReport.missingEffort": "effort",
  "compareReport.missingMode": "mode",
  "compareReport.errorTitle": "Le rapport comparatif n’a pas pu être généré",
  "compareReport.staleTitle": "Résultat précédent conservé",
  "compareReport.staleDescription":
    "L’actualisation a échoué. Le rapport affiché peut être obsolète ; réessayez de l’actualiser.",
  "compareReport.toolbarSummary": "{count} scans / {objective}",
  "compareReport.coverKicker":
    "Intelligence multi-exécutions / dossier de décision",
  "compareReport.coverTitleLead": "Rapport comparatif",
  "compareReport.coverTitleTail": "de scans de sécurité",
  "compareReport.coverDescription":
    "Comparaison de la couverture signalée, du coût opérationnel et des divergences de preuves entre jusqu’à six exécutions.",
  "compareReport.baselineLabel": "BASELINE",
  "compareReport.comparisonSetLabel": "ENSEMBLE COMPARÉ",
  "compareReport.decisionObjectiveLabel": "OBJECTIF DE DÉCISION",
  "compareReport.reportIdLabel": "ID DU RAPPORT",
  "compareReport.comparisonSetValue": "{scans} scans · {candidates} candidats",
  "compareReport.confidentialEvidence": "Confidentiel / preuve locale",
  "compareReport.partialInputs": "{count} entrées partielles",
  "compareReport.winnerKicker": "Gagnant selon un objectif explicite",
  "compareReport.winnerSummary":
    "Mène selon le critère {objective} : {description}. Le classement mesure les résultats signalés, le coût et la durée ; il ne mesure pas la précision sans triage.",
  "compareReport.partialResultTitle": "Résultat partiel :",
  "compareReport.partialResultDescription":
    "l’exécution gagnante a été interrompue après avoir préservé les findings. Sa couverture n’a pas été terminée.",
  "compareReport.completeResultTitle": "Exécution terminée :",
  "compareReport.completeResultDescription":
    "le moteur a terminé le flux, mais les findings requièrent encore un triage technique.",
  "compareReport.scansMetric": "SCANS",
  "compareReport.partialMetric": "PARTIEL",
  "compareReport.totalCostMetric": "COÛT TOTAL",
  "compareReport.knownCostMetric": "COÛT CONNU",
  "compareReport.objectiveMetric": "OBJECTIF",
  "compareReport.readingLimitTitle": "Limite de lecture :",
  "compareReport.readingLimitDescription":
    "davantage de findings ne prouvent pas une meilleure précision ; moins de findings ne prouvent pas la correction. Confirmez un échantillon avant de décider.",
  "compareReport.coverageCostSeverity": "Couverture, coût et sévérité",
  "compareReport.costCoverageKicker":
    "Coût × couverture signalée / taille du nœud = High+",
  "compareReport.severityProfileKicker": "Profil de sévérité / volume absolu",
  "compareReport.noComparableCost":
    "Aucune exécution de cette sélection n’a publié d’estimation USD comparable. Le forfait d’abonnement n’est pas traité comme un coût nul.",
  "compareReport.costCoverageAria": "Graphique du coût par couverture signalée",
  "compareReport.lowCostAxis": "COÛT FAIBLE",
  "compareReport.highCostAxis": "COÛT ÉLEVÉ",
  "compareReport.moreFindingsAxis": "PLUS DE FINDINGS",
  "compareReport.rankingExecution": "Exécution",
  "compareReport.rankingScore": "Score",
  "compareReport.rankingCost": "Coût",
  "compareReport.rankingCostPerFinding": "$/finding",
  "compareReport.totalValue": "{count} au total",
  "compareReport.vsBaseline": "{count} par rapport à la baseline",
  "compareReport.scoreMetric": "Score",
  "compareReport.costMetric": "Coût",
  "compareReport.pairTitle": "Paire {number} / {profile}",
  "compareReport.candidateRole": "CANDIDAT {number}",
  "compareReport.deltaTotal": "Δ TOTAL",
  "compareReport.deltaHigh": "Δ HIGH+",
  "compareReport.deltaCost": "Δ COÛT",
  "compareReport.agreement": "ACCORD",
  "compareReport.operationalReading": "Lecture opérationnelle",
  "compareReport.directionSame": "a signalé le même volume total",
  "compareReport.directionMore": "a signalé {count} findings de plus",
  "compareReport.directionFewer": "a signalé {count} findings de moins",
  "compareReport.operationalSummary":
    "Le candidat {direction}, avec {highDelta} High+ et un coût de {costDelta} par rapport à la baseline. Le coût unitaire est passé de {baselineFindingCost} à {candidateFindingCost} par finding et de {baselineHighCost} à {candidateHighCost} par High+.",
  "compareReport.priorityDivergences":
    "Divergences prioritaires / détail technique",
  "compareReport.noDivergences":
    "Il n’y a aucune divergence de présence ou de sévérité dans cette paire.",
  "compareReport.partialInputTitle": "Entrée partielle :",
  "compareReport.partialInputDescription":
    "au moins un scan a été interrompu après avoir produit des findings ; les chiffres ne représentent pas une couverture terminée.",
  "compareReport.partialBadge": "partiel",
  "compareReport.statusQueued": "en attente",
  "compareReport.statusRunning": "en cours",
  "compareReport.statusCompleted": "terminé",
  "compareReport.statusFailed": "échoué",
  "compareReport.statusCancelled": "annulé",
  "compareReport.statusIncomplete": "incomplet",
  "compareReport.totalMetric": "Total",
  "compareReport.costPerFindingMetric": "$/F",
  "compareReport.noTechnicalSummary":
    "Aucun résumé technique n’a été préservé pour cette occurrence.",
  "compareReport.decisionHandoff": "Transmission de décision",
  "compareReport.conclusionTitle":
    "Le meilleur scan dépend de l’objectif. La vérité dépend du triage.",
  "compareReport.conclusionDescription":
    "Cette comparaison permet de choisir l’efficacité, la couverture ou la vitesse sans mélanger les critères. Pour mesurer la qualité réelle, confirmez les findings et établissez une vérité terrain.",
  "compareReport.nextActions": "Prochaines actions",
  "compareReport.nextActionConfirmSample": "Confirmer l’échantillon partagé",
  "compareReport.nextActionReviewSignals": "Examiner les signaux exclusifs",
  "compareReport.nextActionNormalize": "Normaliser le profil et le périmètre",
  "compareReport.nextActionRecordFalsePositives":
    "Enregistrer les faux positifs",
  "compareReport.nextActionRepeat": "Répéter et comparer à nouveau",
};

export const compareReportMessages = {
  "pt-BR": compareReportPtBR,
  en: compareReportEn,
  es: compareReportEs,
  de: compareReportDe,
  fr: compareReportFr,
};
