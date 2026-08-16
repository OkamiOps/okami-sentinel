import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, PrinterIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { MAX_COMPARE_SCANS, scanEstimatedUsd, type CompareFindingChange, type CompareFindingDelta, type ComparePairResult, type CompareResult, type ScanRun, type Severity } from "@csb/shared";
import { api } from "../api";
import { Kicker, MetaCell, Metric, ReportBrand, ReportFooter, ReportHeader, ReportSheet, ReportText } from "../components/report/ReportPrimitives";
import { buildDecisionRanking, buildMarginalEconomics, isPartialComparableScan, type CompareObjective, type ScanDecisionRow } from "../lib/compare-decision";
import { formatDuration, formatScanUsd, formatUsd, shortId } from "../format";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";
import { executionProfileLabel, hasExecutionProfileMismatch } from "../lib/execution-profile";

const objectiveMeta: Record<CompareObjective, { label: string; description: string }> = {
  balanced: { label: "Equilíbrio", description: "Cobertura 30% · High+ 25% · $/finding 20% · $/High+ 15% · velocidade 10%" },
  coverage: { label: "Cobertura", description: "Maior volume total reportado" },
  high_plus: { label: "High+", description: "Maior volume critical + high reportado" },
  cost_per_finding: { label: "$ / finding", description: "Menor custo por finding reportado" },
  cost_per_high: { label: "$ / High+", description: "Menor custo por finding prioritário reportado" },
  speed: { label: "Velocidade", description: "Menor duração medida" },
};
const severityText: Record<Severity, string> = { critical: "text-chart-4", high: "text-destructive", medium: "text-chart-3", low: "text-primary", info: "text-chart-2", unknown: "text-muted-foreground" };
const changeLabel: Record<CompareFindingChange, string> = { candidate_only: "Só candidato", baseline_only: "Só baseline", both: "Em ambos", severity_changed: "Severidade diferente" };
const changeTone: Record<CompareFindingChange, string> = { candidate_only: "text-primary", baseline_only: "text-chart-3", both: "text-chart-2", severity_changed: "text-chart-4" };

export function CompareReportPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const ids = useMemo(() => [...new Set((params.get("ids") ?? "").split(",").filter(Boolean))].slice(0, MAX_COMPARE_SCANS), [params]);
  const objective = parseObjective(params.get("objective"));
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    setResult(null);
    if (ids.length < 2) {
      setError("Selecione de 2 a 6 scans antes de emitir o relatório comparativo.");
      return () => { active = false; };
    }
    api.compare({ scanIds: ids }).then((value) => { if (active) setResult(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Falha ao montar relatório comparativo"); });
    return () => { active = false; };
  }, [ids, reload]);

  useEffect(() => {
    const previous = document.title;
    document.title = result ? `${result.scans.length} scans · OKAMI Sentinel Comparison Report` : "OKAMI Sentinel Comparison Report";
    return () => { document.title = previous; };
  }, [result]);

  if (error) return <ReportError error={error} onRetry={() => setReload((value) => value + 1)} />;
  if (!result) return <div className="flex min-h-screen items-center justify-center font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">Consolidando comparação…</div>;

  const ranking = buildDecisionRanking(result.scans, objective);
  const marginal = new Map(buildMarginalEconomics(ranking, result.baselineScanId).map((row) => [row.scanId, row]));
  const baseline = result.scans.find((scan) => scan.id === result.baselineScanId)!;
  const partialScans = result.scans.filter(isPartialComparableScan);
  const pricedCosts = result.scans.map(scanEstimatedUsd).filter((value): value is number => value != null);
  const totalCost = pricedCosts.length ? pricedCosts.reduce((sum, value) => sum + value, 0) : null;
  const totalCostIsUpperBound = result.scans.some((scan) => scan.cost?.estimateKind === "upper-bound");
  const reportId = `CMP-${result.baselineScanId.slice(0, 6).toUpperCase()}-${result.scans.length}X`;
  const winner = ranking[0];
  const backHref = `/compare?ids=${result.scans.map((scan) => scan.id).join(",")}`;

  return <div className="report-root min-h-screen bg-[var(--surface-code)] pb-16 text-foreground">
    <div className="report-toolbar report-no-print sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-[210mm] items-center gap-1 px-2 py-3 sm:gap-2 sm:px-4">
        <Button asChild variant="ghost" size="sm"><Link to={backHref}><HugeiconsIcon icon={ArrowLeft01Icon} size={13} />{t("report.back")}</Link></Button>
        <div className="hidden min-w-0 flex-1 truncate px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:block">{result.scans.length} scans / {objectiveMeta[objective].label}</div>
        <Button className="ml-auto" variant="outline" size="sm" aria-label={t("report.refresh")} onClick={() => setReload((value) => value + 1)}><HugeiconsIcon icon={RefreshIcon} size={13} /><span className="hidden sm:inline">{t("report.refresh")}</span></Button>
        <Button size="sm" aria-label={t("report.print")} onClick={() => window.print()}><HugeiconsIcon icon={PrinterIcon} size={13} /><span className="hidden sm:inline">{t("report.print")}</span><span className="sm:hidden">PDF</span></Button>
      </div>
    </div>

    <main className="report-stack">
      <ReportSheet className="report-cover overflow-hidden">
        <img src="/brand/okami-sentinel-mark.png" alt="" className="pointer-events-none absolute -bottom-20 -right-12 w-[34rem] max-w-[72%] opacity-[.14] grayscale" />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <ReportBrand />
          <div className="mt-20 max-w-[38rem]">
            <Kicker>Multi-run intelligence / decision dossier</Kicker>
            <h1 className="mt-5 font-heading text-[3.55rem] font-semibold leading-[.94] tracking-[-.065em]">Security scan<br />comparison report</h1>
            <div className="mt-7 h-px w-28 bg-chart-1" />
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground">Comparação de cobertura reportada, custo operacional e divergência de evidências entre até seis execuções.</p>
          </div>
          <div className="mt-auto grid border-y border-border sm:grid-cols-2">
            <MetaCell label="BASELINE" value={`${baseline.displayName} / ${shortId(baseline.id)}`} />
            <MetaCell label="COMPARISON SET" value={`${result.scans.length} scans · ${result.candidateScanIds.length} candidatos`} />
            <MetaCell label="DECISION OBJECTIVE" value={objectiveMeta[objective].label} />
            <MetaCell label="REPORT ID" value={reportId} />
          </div>
          <div className="mt-7 flex items-center justify-between gap-4 font-mono text-[8px] uppercase tracking-[.16em] text-muted-foreground"><span>Confidential / local evidence</span><span>{partialScans.length} partial inputs</span></div>
        </div>
      </ReportSheet>

      <ReportSheet className="report-executive-sheet">
        <ReportHeader section="01" title={t("report.executive")} reportId={reportId} />
        <div className="mt-9">
          <section className="report-keep border border-border p-6">
            <Kicker>Winner under explicit objective</Kicker>
            <div className="report-executive-winner mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]"><div><div className="flex items-start gap-4"><span className="font-mono text-5xl font-semibold text-primary">01</span><div className="min-w-0"><h2 className="break-words font-heading text-2xl font-semibold leading-tight tracking-[-.04em] sm:text-3xl">{profile(winner.scan)}</h2><p className="mt-1 font-mono text-[8px] text-muted-foreground">{winner.scan.displayName} / {shortId(winner.scan.id)}</p></div></div><p className="mt-6 text-sm leading-7 text-muted-foreground">Lidera no critério <strong className="text-foreground">{objectiveMeta[objective].label}</strong>: {objectiveMeta[objective].description}. O ranking mede resultados reportados, custo e duração; não mede precisão sem triagem.</p></div>{isPartialComparableScan(winner.scan) ? <div className="self-start border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-xs leading-6"><strong>Resultado parcial:</strong> a execução vencedora foi interrompida após preservar findings. Sua cobertura não foi concluída.</div> : <div className="self-start border-l-2 border-chart-2 bg-chart-2/5 px-4 py-3 text-xs leading-6"><strong>Execução concluída:</strong> o motor encerrou o fluxo, mas os findings ainda dependem de triagem técnica.</div>}</div>
          </section>
          <section className="report-keep mt-4 grid grid-cols-2 border border-border sm:grid-cols-4">
            <Metric label="SCANS" value={result.scans.length} />
            <Metric label="PARTIAL" value={partialScans.length} tone="text-chart-3" />
            <Metric label={pricedCosts.length === result.scans.length ? "TOTAL COST" : "KNOWN COST"} value={formatUsd(totalCost, totalCostIsUpperBound)} tone="text-chart-1" kind="currency" />
            <Metric label="OBJECTIVE" value={objectiveMeta[objective].label} tone="text-primary" kind="compact" />
          </section>
        </div>
        <RankingRows rows={ranking} marginal={marginal} />
        <div className="report-executive-note mt-4 border-l-2 border-chart-3 px-4 text-[9px] leading-4 text-muted-foreground"><strong className="text-foreground">Limite da leitura:</strong> mais findings não prova maior precisão; menos findings não prova correção. Confirme uma amostra antes da decisão.</div>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      <ReportSheet>
        <ReportHeader section="02" title="Cobertura, custo e severidade" reportId={reportId} />
        <section className="report-keep mt-8 border border-border p-5">
          <Kicker>Cost × reported coverage / node size = High+</Kicker>
          <CoverageCostPlot rows={ranking} />
        </section>
        <section className="report-keep mt-5 border border-border">
          <div className="border-b border-border px-5 py-4"><Kicker>Severity profile / absolute volume</Kicker></div>
          <div className="p-5"><SeverityProfiles scans={result.scans} /></div>
        </section>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      {result.comparisons.map((comparison, index) => <PairSummarySheet key={comparison.candidateScanId} result={result} comparison={comparison} index={index} reportId={reportId} />)}

      <ReportSheet>
        <ReportHeader section="04" title={t("report.conclusion")} reportId={reportId} />
        <div className="report-conclusion-grid report-keep mt-16 grid gap-6 md:grid-cols-[1.2fr_.8fr]">
          <section><Kicker>Decision handoff</Kicker><h2 className="mt-4 font-heading text-4xl font-semibold tracking-[-.05em]">O melhor scan depende do objetivo. A verdade depende da triagem.</h2><p className="mt-6 text-base leading-8 text-muted-foreground">Este comparativo permite escolher eficiência, cobertura ou velocidade sem misturar os critérios. Para medir qualidade real, confirme findings e estabeleça ground truth.</p></section>
          <div className="border border-border p-6"><Kicker>Next actions</Kicker><ol className="mt-5 space-y-5">{["Confirmar amostra compartilhada", "Revisar sinais exclusivos", "Normalizar perfil e escopo", "Registrar falsos positivos", "Repetir e comparar novamente"].map((item, index) => <li key={item} className="flex gap-4"><span className="font-mono text-xs text-primary">0{index + 1}</span><span className="text-sm">{item}</span></li>)}</ol></div>
        </div>
        <div className="mt-auto flex flex-col items-center justify-center py-16 text-center"><img src="/brand/okami-sentinel-mark.png" alt="OKAMI Sentinel" className="h-32 w-32 object-contain" /><div className="mt-4 font-heading text-xl font-semibold tracking-[.25em]">OKAMI</div><div className="font-mono text-[9px] uppercase tracking-[.45em] text-muted-foreground">Sentinel</div></div>
        <ReportFooter reportId={reportId} />
      </ReportSheet>
    </main>
  </div>;
}

function RankingRows({ rows, marginal }: { rows: ScanDecisionRow[]; marginal: Map<string, ReturnType<typeof buildMarginalEconomics>[number]> }) {
  return <section className="mt-5 border border-border">
    <div className="hidden sm:block"><div className="report-row grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_4rem_5.5rem_5.5rem] border-b border-border bg-muted/40 px-4 py-2 font-mono text-[7px] uppercase tracking-wider text-muted-foreground"><span>#</span><span>Execution</span><span>Score</span><span>High+</span><span>Cost</span><span>$/finding</span></div>{rows.map((row, index) => <div key={row.scan.id} className="report-row grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_4rem_5.5rem_5.5rem] items-center border-b border-border px-4 py-3 last:border-0"><span className="font-mono text-sm text-primary">0{index + 1}</span><div className="min-w-0 pr-3"><div className="report-copy text-[10px] font-semibold leading-4">{profile(row.scan)}</div><div className="report-copy mt-1 font-mono text-[7px] leading-3 text-muted-foreground">{shortId(row.scan.id)} · {row.total} total{marginal.get(row.scan.id)?.extraFindings ? ` · ${signed(marginal.get(row.scan.id)!.extraFindings)} vs baseline` : ""}</div></div><span className="font-mono text-[10px]">{row.score.toFixed(1)}</span><span className="font-mono text-[10px] text-chart-4">{row.highPlus}</span><span className="report-copy font-mono text-[8px] text-chart-1">{formatUsd(row.costUsd, row.scan.cost?.estimateKind === "upper-bound")}</span><span className="report-copy font-mono text-[8px] text-primary">{formatUsd(row.costPerFinding, row.scan.cost?.estimateKind === "upper-bound")}</span></div>)}</div>
    <div className="sm:hidden">{rows.map((row, index) => <div key={row.scan.id} className="report-row border-b border-border p-4 last:border-0"><div className="flex items-start gap-3"><span className="font-mono text-lg text-primary">0{index + 1}</span><div className="min-w-0"><div className="break-words text-[11px] font-semibold">{profile(row.scan)}</div><div className="mt-1 font-mono text-[7px] text-muted-foreground">{shortId(row.scan.id)} · {row.total} total</div></div></div><div className="mt-3 grid grid-cols-4 border border-border"><SmallMetric label="Score" value={row.score.toFixed(1)} /><SmallMetric label="High+" value={row.highPlus} /><SmallMetric label="Cost" value={formatUsd(row.costUsd, row.scan.cost?.estimateKind === "upper-bound")} /><SmallMetric label="$/F" value={formatUsd(row.costPerFinding, row.scan.cost?.estimateKind === "upper-bound")} /></div></div>)}</div>
  </section>;
}

function CoverageCostPlot({ rows }: { rows: ScanDecisionRow[] }) {
  const pricedRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.costUsd != null);
  if (!pricedRows.length) return <div className="mt-4 border border-border p-6 text-[10px] leading-5 text-muted-foreground">Nenhuma execução deste recorte publicou uma estimativa USD comparável. Uso de franquia da assinatura não é tratado como custo zero.</div>;
  const maxCost = Math.max(1, ...pricedRows.map(({ row }) => row.costUsd!));
  const maxTotal = Math.max(1, ...pricedRows.map(({ row }) => row.total));
  const maxHigh = Math.max(1, ...pricedRows.map(({ row }) => row.highPlus));
  return <div className="mt-4"><svg viewBox="0 0 640 300" role="img" aria-label="Gráfico de custo por cobertura reportada" className="h-auto w-full"><line x1="58" y1="248" x2="596" y2="248" stroke="var(--border)" /><line x1="58" y1="34" x2="58" y2="248" stroke="var(--border)" />{[0.25, 0.5, 0.75, 1].map((ratio) => <g key={ratio}><line x1="58" y1={248 - ratio * 198} x2="596" y2={248 - ratio * 198} stroke="var(--border)" strokeDasharray="2 6" /><line x1={58 + ratio * 516} y1="34" x2={58 + ratio * 516} y2="248" stroke="var(--border)" strokeDasharray="2 6" /></g>)}<text x="58" y="278" fill="var(--muted-foreground)" fontSize="9">LOW COST</text><text x="528" y="278" fill="var(--muted-foreground)" fontSize="9">HIGH COST</text><text x="63" y="22" fill="var(--muted-foreground)" fontSize="9">MORE FINDINGS</text>{pricedRows.map(({ row, index }) => { const radius = 8 + (row.highPlus / maxHigh) * 10; const x = 58 + radius + (row.costUsd! / maxCost) * (516 - radius * 2); const y = 248 - radius - (row.total / maxTotal) * (198 - radius * 2); return <g key={row.scan.id}><circle cx={x} cy={y} r={radius} fill={index === 0 ? "var(--primary)" : `var(--chart-${(index % 5) + 1})`} fillOpacity=".78" stroke="var(--foreground)" strokeWidth="1" /><text x={x} y={y + 3} textAnchor="middle" fill="var(--background)" fontSize="8" fontWeight="700">S{index + 1}</text></g>; })}</svg><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{rows.map((row, index) => <div key={row.scan.id} className="flex min-w-0 items-start gap-2 border border-border px-2 py-2"><span className="font-mono text-[8px] text-primary">S{index + 1}</span><span className="report-copy min-w-0 font-mono text-[7px] leading-3 text-muted-foreground">{profile(row.scan)} · {formatUsd(row.costUsd, row.scan.cost?.estimateKind === "upper-bound")} · {row.total} total</span></div>)}</div></div>;
}

function SeverityProfiles({ scans }: { scans: ScanRun[] }) {
  const max = Math.max(1, ...scans.map((scan) => scan.severity.total));
  return <div className="space-y-3">{scans.map((scan, index) => <div key={scan.id} className="grid grid-cols-[2rem_10.5rem_minmax(0,1fr)_3rem] items-center gap-3"><span className="font-mono text-[8px] text-primary">S{index + 1}</span><span className="report-copy font-mono text-[7px] leading-3">{profile(scan)}</span><div className="flex h-3 bg-muted">{(["critical", "high", "medium", "low", "info"] as const).map((severity) => <span key={severity} className={severity === "critical" ? "bg-chart-4" : severity === "high" ? "bg-destructive" : severity === "medium" ? "bg-chart-3" : severity === "low" ? "bg-primary" : "bg-chart-2"} style={{ width: `${(scan.severity[severity] / max) * 100}%` }} />)}</div><span className="text-right font-mono text-[9px]">{scan.severity.total}</span></div>)}</div>;
}

function PairSummarySheet({ result, comparison, index, reportId }: { result: CompareResult; comparison: ComparePairResult; index: number; reportId: string }) {
  const { t } = useI18n();
  const baseline = result.scans.find((scan) => scan.id === result.baselineScanId)!;
  const candidate = result.scans.find((scan) => scan.id === comparison.candidateScanId)!;
  const baselineHigh = baseline.severity.critical + baseline.severity.high;
  const candidateHigh = candidate.severity.critical + candidate.severity.high;
  const total = comparison.findings.length || 1;
  const baselineCost = scanEstimatedUsd(baseline);
  const candidateCost = scanEstimatedUsd(candidate);
  const costDelta = baselineCost == null || candidateCost == null ||
      baseline.cost?.estimateKind === "upper-bound" || candidate.cost?.estimateKind === "upper-bound"
    ? null
    : candidateCost - baselineCost;
  const baselineCostPerFinding = unitCost(baselineCost, baseline.severity.total);
  const candidateCostPerFinding = unitCost(candidateCost, candidate.severity.total);
  const baselineCostPerHigh = unitCost(baselineCost, baselineHigh);
  const candidateCostPerHigh = unitCost(candidateCost, candidateHigh);
  const agreement = Math.round(((comparison.counts.both + comparison.counts.severity_changed) / total) * 100);
  const priority = priorityDivergences(comparison.findings, 3);
  const direction = candidate.severity.total === baseline.severity.total ? "reportou o mesmo volume total" : candidate.severity.total > baseline.severity.total ? `reportou ${candidate.severity.total - baseline.severity.total} findings a mais` : `reportou ${baseline.severity.total - candidate.severity.total} findings a menos`;
  return <ReportSheet>
    <ReportHeader section="03" title={`Pair ${String(index + 1).padStart(2, "0")} / ${profile(candidate)}`} reportId={reportId} />
    <div className="report-run-comparison report-keep mt-7 grid gap-3 md:grid-cols-[1fr_auto_1fr]"><RunCard role="BASELINE" scan={baseline} /><div className="report-run-arrow hidden items-center font-mono text-xl text-primary md:flex">→</div><RunCard role={`CANDIDATE ${String(index + 1).padStart(2, "0")}`} scan={candidate} /></div>
    <section className="report-keep mt-4 grid grid-cols-2 border border-border sm:grid-cols-4"><Metric label="Δ TOTAL" value={signed(candidate.severity.total - baseline.severity.total)} tone="text-primary" /><Metric label="Δ HIGH+" value={signed(candidateHigh - baselineHigh)} tone="text-chart-4" /><Metric label="Δ COST" value={formatSignedUsd(costDelta)} tone="text-chart-1" kind="currency" /><Metric label="AGREEMENT" value={`${agreement}%`} tone="text-chart-2" /></section>
    <section className="report-keep mt-4 border border-border p-4"><Kicker>Operational reading</Kicker><p className="mt-3 text-[11px] leading-5 text-muted-foreground">O candidato {direction}, com {signed(candidateHigh - baselineHigh)} High+ e custo {formatSignedUsd(costDelta)} contra o baseline. O custo unitário mudou de <strong className="text-foreground">{formatUsd(baselineCostPerFinding, baseline.cost?.estimateKind === "upper-bound")}</strong> para <strong className="text-foreground">{formatUsd(candidateCostPerFinding, candidate.cost?.estimateKind === "upper-bound")}</strong> por finding e de <strong className="text-foreground">{formatUsd(baselineCostPerHigh, baseline.cost?.estimateKind === "upper-bound")}</strong> para <strong className="text-foreground">{formatUsd(candidateCostPerHigh, candidate.cost?.estimateKind === "upper-bound")}</strong> por High+.</p><div className="mt-3 flex h-3 bg-muted">{(["candidate_only", "severity_changed", "both", "baseline_only"] as CompareFindingChange[]).map((change) => <span key={change} className={change === "candidate_only" ? "bg-primary" : change === "severity_changed" ? "bg-chart-4" : change === "both" ? "bg-chart-2" : "bg-chart-3"} style={{ width: `${(comparison.counts[change] / total) * 100}%` }} />)}</div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{(["candidate_only", "severity_changed", "both", "baseline_only"] as CompareFindingChange[]).map((change) => <div key={change} className="flex items-center justify-between border border-border px-2 py-2"><span className={`font-mono text-[6px] uppercase ${changeTone[change]}`}>{changeLabel[change]}</span><strong className="font-mono text-[10px]">{comparison.counts[change]}</strong></div>)}</div></section>
    <section className="mt-4 border border-border"><div className="report-keep border-b border-border px-4 py-3"><Kicker>Priority divergences / technical detail</Kicker></div><div className="report-findings-grid grid md:grid-cols-3">{priority.map((finding) => <DetailedFinding key={finding.key} finding={finding} />)}{!priority.length && <div className="report-keep p-6 text-xs text-muted-foreground">Nenhuma divergência de presença ou severidade neste par.</div>}</div></section>
    {hasExecutionProfileMismatch([baseline, candidate]) && <div className="report-keep mt-5 border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-[10px] leading-5">{t("compare.profileMismatch")}</div>}
    {(isPartialComparableScan(baseline) || isPartialComparableScan(candidate)) && <div className="report-keep mt-5 border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-[10px] leading-5"><strong>Entrada parcial:</strong> pelo menos um scan foi interrompido depois de produzir findings; os números não representam cobertura concluída.</div>}
    <ReportFooter reportId={reportId} />
  </ReportSheet>;
}

function RunCard({ role, scan }: { role: string; scan: ScanRun }) {
  const { t } = useI18n();
  const highPlus = scan.severity.critical + scan.severity.high;
  const estimatedUsd = scanEstimatedUsd(scan);
  const costPerFinding = estimatedUsd != null && scan.severity.total ? estimatedUsd / scan.severity.total : null;
  const executionProfile = executionProfileLabel(scan, t);
  return <div className="min-w-0 border border-border p-4"><Kicker>{role}</Kicker><div className="mt-2 flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="report-copy font-heading text-sm font-semibold leading-5">{profile(scan)}</h3><p className="report-copy mt-1 font-mono text-[7px] leading-3 text-muted-foreground">{shortId(scan.id)} · {scan.status} · {formatDuration(scan.durationMs)}</p></div>{isPartialComparableScan(scan) && <span className="border border-chart-3/50 px-2 py-1 font-mono text-[7px] uppercase text-chart-3">partial</span>}</div>{scan.execution && <p className="report-copy mt-3 border-l border-border pl-3 font-mono text-[7px] leading-3 text-muted-foreground">{executionProfile ?? "—"} · {scan.execution.protocol ?? "—"} · {scan.execution.authKind ?? "—"}</p>}<div className="mt-3 grid grid-cols-4 border border-border"><SmallMetric label="Total" value={scan.severity.total} /><SmallMetric label="High+" value={highPlus} /><SmallMetric label="Cost" value={formatScanUsd(scan)} /><SmallMetric label="$/F" value={formatUsd(costPerFinding, scan.cost?.estimateKind === "upper-bound")} /></div></div>;
}

function SmallMetric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="min-w-0 border-r border-border p-2 last:border-0"><div className="report-copy font-mono text-[7px] uppercase text-muted-foreground">{label}</div><div className="report-copy mt-1 font-mono text-[8px] leading-3 tabular-nums">{value}</div></div>;
}

function DetailedFinding({ finding }: { finding: CompareFindingDelta }) {
  const baselineSeverity = finding.baseline?.severity ?? "—";
  const candidateSeverity = finding.candidate?.severity ?? "—";
  const occurrence = finding.candidate ?? finding.baseline;
  return <article className="report-keep min-w-0 border-b border-r border-border p-4"><div className="flex items-start justify-between gap-2"><span className={`font-mono text-[7px] uppercase ${changeTone[finding.change]}`}>{changeLabel[finding.change]}</span><span className="shrink-0 font-mono text-[7px] uppercase"><span className={baselineSeverity === "—" ? "text-muted-foreground" : severityText[baselineSeverity]}>{baselineSeverity}</span><span className="mx-1 text-muted-foreground">→</span><span className={candidateSeverity === "—" ? "text-muted-foreground" : severityText[candidateSeverity]}>{candidateSeverity}</span></span></div><h3 className="report-copy mt-3 text-[10px] font-semibold leading-4">{finding.title}</h3><p className="report-copy mt-2 text-[9px] leading-4 text-muted-foreground">{trimText(occurrence?.summary ?? "Sem resumo técnico preservado para esta ocorrência.", 180)}</p><div className="report-copy mt-3 font-mono text-[7px] leading-3 text-muted-foreground">{occurrence?.primaryPath ?? occurrence?.category ?? finding.key}{occurrence?.cwe.length ? ` · ${occurrence.cwe.join(", ")}` : ""}</div></article>;
}

function ReportError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useI18n();
  return <div className="flex min-h-screen items-center justify-center p-6"><div className="w-full max-w-xl border border-destructive/50 bg-destructive/10 p-6"><div className="font-mono text-[9px] uppercase tracking-[.16em] text-destructive">Comparison report failed</div><p className="mt-3 text-sm">{error}</p><Button className="mt-5" onClick={onRetry}><HugeiconsIcon icon={RefreshIcon} size={13} />{t("common.retry")}</Button></div></div>;
}

function parseObjective(value: string | null): CompareObjective {
  return value && value in objectiveMeta ? value as CompareObjective : "balanced";
}

function profile(scan: ScanRun): string {
  return `${scan.engine} · ${scan.model ?? "model"}/${scan.effort ?? "effort"}/${scan.mode ?? "mode"}`;
}

function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
function formatSignedUsd(value: number | null): string { return value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatUsd(Math.abs(value))}`; }
function unitCost(cost: number | null | undefined, findings: number): number | null { return cost == null || findings <= 0 ? null : cost / findings; }
function trimText(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`; }
function priorityDivergences(findings: CompareFindingDelta[], limit: number): CompareFindingDelta[] {
  const divergent = findings.filter((finding) => finding.change !== "both");
  const picked: CompareFindingDelta[] = [];
  (["candidate_only", "severity_changed", "baseline_only"] as CompareFindingChange[]).forEach((change) => {
    const finding = divergent.find((item) => item.change === change);
    if (finding) picked.push(finding);
  });
  for (const finding of divergent) {
    if (picked.length >= limit) break;
    if (!picked.includes(finding)) picked.push(finding);
  }
  return picked.slice(0, limit);
}
