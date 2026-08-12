import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, PrinterIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { scanEstimatedUsd, type FindingDetail, type FindingLifecycle, type LifecycleFinding, type Severity } from "@csb/shared";
import { api, type ScanReportData } from "../api";
import { Kicker, MetaCell, Metric, ReportBrand, ReportFooter, ReportHeader, ReportSheet, ReportText } from "../components/report/ReportPrimitives";
import { formatDate, formatDuration, formatScanUsd, formatTokens, formatUsd, shortId } from "../format";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";
import { reasoningDeliveryCopy, scanReasoningDelivery } from "../lib/reasoning-delivery";
import { executionProfileLabel } from "../lib/execution-profile";
import { scanCostPresentation, scanTokenUsage } from "../lib/scan-cost";

const severityOrder: Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];
const severityLabel: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
  unknown: "Unknown",
};
const severityText: Record<Severity, string> = {
  critical: "text-chart-4",
  high: "text-destructive",
  medium: "text-chart-3",
  low: "text-primary",
  info: "text-muted-foreground",
  unknown: "text-muted-foreground",
};
const severityBar: Record<Severity, string> = {
  critical: "bg-chart-4",
  high: "bg-destructive",
  medium: "bg-chart-3",
  low: "bg-primary",
  info: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
};
const lifecycleLabel: Record<FindingLifecycle, string> = {
  new: "novo",
  persisting: "persistente",
  fixed: "ausente nesta execução",
  regressed: "reincidente",
};

export function ScanReportPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const [data, setData] = useState<ScanReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    api.report(id).then((value) => {
      if (active) setData(value);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Falha ao montar relatório");
    });
    return () => { active = false; };
  }, [id, reload]);

  useEffect(() => {
    const previous = document.title;
    document.title = data ? `${data.scan.displayName} · OKAMI Sentinel Report` : "OKAMI Sentinel Report";
    return () => { document.title = previous; };
  }, [data]);

  const findings = useMemo(() => sortFindings(data?.findings ?? []), [data]);
  const indexPages = useMemo(() => chunk(findings, 12), [findings]);
  const priorityFindings = useMemo(() => findings.filter((finding) => finding.severity === "critical" || finding.severity === "high"), [findings]);
  const lifecycle = useMemo(() => new Map((data?.regression.findings ?? []).map((finding) => [finding.findingId, finding])), [data]);

  if (error) {
    return <div className="flex min-h-screen items-center justify-center p-6"><div className="w-full max-w-xl border border-destructive/50 bg-destructive/10 p-6"><div className="font-mono text-[9px] uppercase tracking-[.16em] text-destructive">Report generation failed</div><p className="mt-3 text-sm">{error}</p><Button className="mt-5" onClick={() => setReload((value) => value + 1)}><HugeiconsIcon icon={RefreshIcon} size={13} />{t("common.retry")}</Button></div></div>;
  }

  if (!data) {
    return <div className="flex min-h-screen items-center justify-center font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">Montando evidence dossier…</div>;
  }

  const { scan, regression, generatedAt } = data;
  const partial = (scan.status === "failed" || scan.status === "incomplete") && scan.severity.total > 0;
  const highPlus = scan.severity.critical + scan.severity.high;
  const estimatedUsd = scanEstimatedUsd(scan);
  const costCopy = scanCostPresentation(scan.cost);
  const tokenUsage = scanTokenUsage(scan);
  const usdPerFinding = estimatedUsd != null && scan.severity.total ? estimatedUsd / scan.severity.total : null;
  const reportId = `SNT-${scan.id.toUpperCase()}`;
  const resolvedExecutionProfileLabel = executionProfileLabel(scan, t);
  const reasoningCopy = reasoningDeliveryCopy(scanReasoningDelivery(scan));

  return <div className="report-root min-h-screen bg-[#040407] pb-16 text-foreground">
    <div className="report-toolbar report-no-print sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-[210mm] items-center gap-1 px-2 py-3 sm:gap-2 sm:px-4">
        <Button asChild variant="ghost" size="sm"><Link to={`/scans/${scan.id}`}><HugeiconsIcon icon={ArrowLeft01Icon} size={13} />{t("report.back")}</Link></Button>
        <div className="hidden min-w-0 flex-1 truncate px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:block">{scan.displayName} / {shortId(scan.id)}</div>
        <Button className="ml-auto" variant="outline" size="sm" aria-label={t("report.refresh")} onClick={() => setReload((value) => value + 1)}><HugeiconsIcon icon={RefreshIcon} size={13} /><span className="hidden sm:inline">{t("report.refresh")}</span></Button>
        <Button size="sm" aria-label={t("report.print")} onClick={() => window.print()}><HugeiconsIcon icon={PrinterIcon} size={13} /><span className="hidden sm:inline">{t("report.print")}</span><span className="sm:hidden">PDF</span></Button>
      </div>
    </div>

    <main className="report-stack">
      <ReportSheet className="report-cover overflow-hidden">
        <img src="/brand/okami-sentinel-mark.png" alt="" className="pointer-events-none absolute -bottom-20 -right-12 w-[34rem] max-w-[72%] opacity-[.16] grayscale" />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <ReportBrand />
          <div className="mt-20 max-w-[34rem]">
            <Kicker>Security intelligence / evidence dossier</Kicker>
            <h1 className="mt-5 font-heading text-[3.7rem] font-semibold leading-[.94] tracking-[-.065em]">Security<br />scan report</h1>
            <div className="mt-7 h-px w-28 bg-chart-1" />
            <p className="mt-7 max-w-lg text-lg leading-relaxed text-muted-foreground">Leitura técnica da superfície observada, eficiência da execução e evidências reportadas pelo motor local.</p>
          </div>
          <div className="mt-auto grid border-y border-border sm:grid-cols-2">
            <MetaCell label="TARGET" value={scan.displayName} />
            <MetaCell label="REPORT ID" value={reportId} />
            <MetaCell label="SCAN CHANNEL" value={`${scan.engine}${resolvedExecutionProfileLabel ? ` · ${resolvedExecutionProfileLabel}` : ""} · ${scan.model ?? "—"}/${scan.effort ?? "—"}/${scan.mode ?? "—"}`} />
            <MetaCell label="GENERATED" value={formatDate(generatedAt)} />
          </div>
          <div className="mt-7 flex items-center justify-between gap-4 font-mono text-[8px] uppercase tracking-[.16em] text-muted-foreground"><span>Confidential / local evidence</span><span>{scan.status.toUpperCase()}</span></div>
        </div>
      </ReportSheet>

      <ReportSheet>
        <ReportHeader section="01" title={t("report.executive")} reportId={reportId} />
        <div className="mt-10 grid gap-4 md:grid-cols-[1.35fr_.65fr]">
          <section className="border border-border p-6">
            <Kicker>Decision signal</Kicker>
            <h2 className="mt-3 font-heading text-3xl font-semibold tracking-[-.045em]">{partial ? "Resultado parcial com evidência preservada" : scan.status === "completed" ? "Cobertura concluída pelo motor" : `Execução ${scan.status}`}</h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">{partial ? `O scan foi interrompido depois de produzir ${scan.severity.total} findings. Esses resultados são úteis para investigação, mas não representam cobertura concluída nem equivalem a uma execução bem-sucedida.` : `A execução reportou ${scan.severity.total} findings, sendo ${highPlus} classificados como critical ou high. A severidade é a classificação produzida pelo scan e ainda exige triagem técnica.`}</p>
            <div className="mt-6 border-l-2 border-chart-3 bg-chart-3/5 px-4 py-3 text-xs leading-6"><strong>Limite da leitura:</strong> o relatório contém somente findings desta execução. O baseline classifica sinais atuais coincidentes; uma ausência não é apresentada como correção nem prova remediação.</div>
          </section>
          <section className="grid grid-cols-2 border border-border">
            <Metric label="FINDINGS" value={scan.severity.total} />
            <Metric label="HIGH+" value={highPlus} tone="text-chart-4" />
            <Metric label={t(costCopy.labelKey)} value={formatScanUsd(scan)} tone="text-chart-1" />
            <Metric label="$ / FINDING" value={formatUsd(usdPerFinding, scan.cost?.estimateKind === "upper-bound")} tone="text-primary" />
          </section>
        </div>

        <section className="mt-5 border border-border">
          <div className="border-b border-border px-5 py-4"><Kicker>Risk distribution / reported volume</Kicker></div>
          <div className="grid gap-0 md:grid-cols-[1fr_13rem]">
            <div className="p-5">
              {severityOrder.slice(0, 5).map((severity) => <SeverityRow key={severity} severity={severity} count={scan.severity[severity]} total={scan.severity.total} />)}
            </div>
            <div className="grid grid-cols-3 border-t border-border md:border-l md:border-t-0">
              <Metric label="NEW" value={regression.counts.new} tone="text-primary" />
              <Metric label="REGRESSED" value={regression.counts.regressed} tone="text-destructive" />
              <Metric label="PERSISTING" value={regression.counts.persisting} tone="text-chart-3" />
            </div>
          </div>
        </section>

        <section className="mt-5 grid border border-border sm:grid-cols-2 lg:grid-cols-4">
          <MetaCell label="DURATION" value={formatDuration(scan.durationMs)} />
          <MetaCell label="INPUT TOKENS" value={formatTokens(tokenUsage.inputTokens)} />
          <MetaCell label="OUTPUT TOKENS" value={formatTokens(tokenUsage.outputTokens)} />
          <MetaCell label="BASELINE" value={regression.baseline ? `${regression.baseline.displayName} / ${shortId(regression.baseline.id)}` : "sem baseline"} />
        </section>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      <ReportSheet>
        <ReportHeader section="02" title="Manifesto da execução" reportId={reportId} />
        <div className="mt-10 grid border border-border sm:grid-cols-2">
          <MetaCell label="SCAN ID" value={scan.id} />
          <MetaCell label="STATUS" value={partial ? "FAILED / PARTIAL RESULTS" : scan.status.toUpperCase()} />
          <MetaCell label="REPOSITORY" value={scan.repositoryPath ?? "—"} />
          <MetaCell label="REVISION" value={scan.revision ?? "—"} />
          <MetaCell label="ENGINE" value={scan.engine} />
          <MetaCell label="AUTHENTICATION" value={scan.authMode ?? "—"} />
          {scan.execution && <>
            <MetaCell label={t("report.executionProfile")} value={resolvedExecutionProfileLabel ?? "—"} />
            <MetaCell label={t("report.profileVersion")} value={scan.execution.profileVersion} />
            <MetaCell label={t("report.methodologyRef")} value={scan.execution.methodologyRef} />
            <MetaCell label={t("report.protocol")} value={scan.execution.protocol ?? "—"} />
            <MetaCell label={t("report.connectionAuth")} value={scan.execution.authKind ?? "—"} />
          </>}
          <MetaCell label="MODEL" value={scan.model ?? "—"} />
          <MetaCell label="REASONING DELIVERY" value={t(reasoningCopy.key, reasoningCopy.variables)} />
          <MetaCell label="SCAN MODE" value={scan.mode ?? "—"} />
          <MetaCell label="SCANNER VERSION" value={scan.scannerVersion ?? "—"} />
          <MetaCell label="RECIPE HASH" value={scan.recipeHash ?? "—"} />
          <MetaCell label="SOURCE" value={scan.source} />
          <MetaCell label="STARTED" value={formatDate(scan.startedAt)} />
          <MetaCell label="COMPLETED" value={formatDate(scan.completedAt)} />
        </div>
        <section className="mt-6 grid gap-5 md:grid-cols-2">
          {scan.execution?.executionProfile === "portable" && <ReportText title={t("report.executionProfile")}>{t("report.portableDisclosure")}</ReportText>}
          <ReportText title="Como ler este documento">O índice contém todos os findings reportados por esta execução. Evidências detalhadas são apresentadas para itens critical e high; os demais continuam visíveis no inventário para triagem e rastreabilidade.</ReportText>
          <ReportText title="O que este documento não prova">Uma diferença entre scans pode resultar de cobertura, modelo, esforço, interrupção ou não determinismo. “Ausente nesta execução” não é sinônimo automático de corrigido.</ReportText>
          <ReportText title="Método">Análise estática assistida por modelo no repositório informado, com consolidação local de evidências, classificação de severidade, custo estimado e fingerprint de lifecycle.</ReportText>
          <ReportText title="Prioridade sugerida">Validar critical/high com maior impacto e confiança, confirmar o caminho executável, registrar triagem e repetir o mesmo perfil após a correção.</ReportText>
        </section>
        <ReportFooter reportId={reportId} />
      </ReportSheet>

      {indexPages.map((page, pageIndex) => <ReportSheet key={`index-${pageIndex}`}>
        <ReportHeader section="03" title={`Índice de findings${indexPages.length > 1 ? ` / ${pageIndex + 1}` : ""}`} reportId={reportId} />
        <div className="mt-8 border border-border">
          <div className="report-index-grid grid grid-cols-[4.2rem_5.2rem_minmax(0,1fr)_7rem] border-b border-border bg-muted/40 px-4 py-3 font-mono text-[8px] uppercase tracking-[.13em] text-muted-foreground"><span>Ref.</span><span>Risk</span><span>Finding / location</span><span className="report-index-lifecycle">Lifecycle</span></div>
          {page.map((finding) => <FindingIndexRow key={finding.findingId} finding={finding} index={findings.indexOf(finding)} signal={lifecycle.get(finding.findingId)} />)}
        </div>
        <div className="mt-5 border-l-2 border-primary px-4 text-[11px] leading-6 text-muted-foreground">{priorityFindings.length} findings critical/high possuem ficha técnica detalhada nas páginas seguintes. Os demais permanecem no inventário sem expansão para evitar narrativa gerada além da evidência.</div>
        <ReportFooter reportId={reportId} />
      </ReportSheet>)}

      {priorityFindings.map((finding) => <FindingSheet key={finding.findingId} finding={finding} index={findings.indexOf(finding)} signal={lifecycle.get(finding.findingId)} reportId={reportId} />)}

      <ReportSheet>
        <ReportHeader section="05" title="Fechamento e próxima ação" reportId={reportId} />
        <div className="mt-16 grid gap-6 md:grid-cols-[1.2fr_.8fr]">
          <section>
            <Kicker>Operator handoff</Kicker>
            <h2 className="mt-4 font-heading text-4xl font-semibold tracking-[-.05em]">Evidência não é decisão automática.</h2>
            <p className="mt-6 text-base leading-8 text-muted-foreground">Use este dossier para selecionar evidências prioritárias, confirmar explorabilidade no contexto do produto e registrar a decisão de triagem. Depois, repita o mesmo perfil para medir mudança de forma comparável.</p>
          </section>
          <div className="border border-border p-6">
            <Kicker>Suggested sequence</Kicker>
            <ol className="mt-5 space-y-5">{["Confirmar critical/high", "Registrar triagem e owner", "Corrigir por causa raiz", "Repetir o mesmo perfil", "Comparar custo e cobertura"].map((item, index) => <li key={item} className="flex gap-4"><span className="font-mono text-xs text-primary">0{index + 1}</span><span className="text-sm">{item}</span></li>)}</ol>
          </div>
        </div>
        <div className="mt-auto flex flex-col items-center justify-center py-20 text-center">
          <img src="/brand/okami-sentinel-mark.png" alt="OKAMI Sentinel" className="h-32 w-32 object-contain" />
          <div className="mt-4 font-heading text-xl font-semibold tracking-[.25em]">OKAMI</div>
          <div className="font-mono text-[9px] uppercase tracking-[.45em] text-muted-foreground">Sentinel</div>
        </div>
        <ReportFooter reportId={reportId} />
      </ReportSheet>
    </main>
  </div>;
}

function SeverityRow({ severity, count, total }: { severity: Severity; count: number; total: number }) {
  const percentage = total ? Math.round((count / total) * 100) : 0;
  return <div className="grid grid-cols-[5rem_minmax(0,1fr)_4rem] items-center gap-3 border-b border-border/70 py-3 last:border-0"><span className={`font-mono text-[9px] uppercase ${severityText[severity]}`}>{severityLabel[severity]}</span><div className="h-2 bg-muted"><div className={`h-full ${severityBar[severity]}`} style={{ width: `${percentage}%` }} /></div><span className="text-right font-mono text-[9px]">{count} / {percentage}%</span></div>;
}

function FindingIndexRow({ finding, index, signal }: { finding: FindingDetail; index: number; signal?: LifecycleFinding }) {
  return <div className="report-index-grid grid grid-cols-[4.2rem_5.2rem_minmax(0,1fr)_7rem] items-center border-b border-border px-4 py-3 last:border-0"><span className="font-mono text-[8px] text-primary">OKS-{String(index + 1).padStart(3, "0")}</span><span className={`font-mono text-[8px] uppercase ${severityText[finding.severity]}`}>{severityLabel[finding.severity]}</span><div className="min-w-0 pr-4"><div className="truncate text-[11px] font-semibold">{finding.title}</div><div className="mt-1 truncate font-mono text-[7px] text-muted-foreground">{finding.primaryPath ?? finding.category ?? finding.findingId}</div><div className="mt-1 font-mono text-[7px] uppercase text-muted-foreground sm:hidden">{signal ? lifecycleLabel[signal.lifecycle] : "sem delta"}</div></div><span className="report-index-lifecycle font-mono text-[7px] uppercase text-muted-foreground">{signal ? lifecycleLabel[signal.lifecycle] : "sem delta"}</span></div>;
}

function FindingSheet({ finding, index, signal, reportId }: { finding: FindingDetail; index: number; signal?: LifecycleFinding; reportId: string }) {
  const evidence = flattenText(finding.codeEvidence, 6);
  const validation = flattenText(finding.validation, 6);
  const remediation = flattenText(finding.remediation, 6);
  const locations = locationList(finding.locations);
  return <ReportSheet>
    <ReportHeader section="04" title={`OKS-${String(index + 1).padStart(3, "0")} / Technical finding`} reportId={reportId} />
    <div className="mt-8 flex flex-wrap items-center gap-2"><span className={`border border-current px-2 py-1 font-mono text-[8px] uppercase ${severityText[finding.severity]}`}>{severityLabel[finding.severity]}</span><span className="border border-border px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">confidence / {finding.confidence ?? "unknown"}</span>{signal && <span className="border border-border px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">{lifecycleLabel[signal.lifecycle]}</span>}</div>
    <h2 className="mt-5 max-w-3xl font-heading text-3xl font-semibold leading-tight tracking-[-.04em]">{finding.title}</h2>
    <p className="mt-5 max-w-3xl text-sm leading-7 text-muted-foreground">{finding.summary ?? "O scan não forneceu resumo textual para este finding."}</p>
    <div className="mt-7 grid border border-border sm:grid-cols-2">
      <MetaCell label="PRIMARY LOCATION" value={finding.primaryPath ?? "—"} />
      <MetaCell label="CWE / RULE" value={[...finding.cwe, finding.ruleId].filter(Boolean).join(" · ") || "—"} />
      <MetaCell label="CATEGORY" value={finding.category ?? "—"} />
      <MetaCell label="TRIAGE" value={signal ? signal.triage.status.replace("_", " ") : "unreviewed"} />
    </div>
    {locations.length > 0 && <ReportSection title="Affected locations"><div className="flex flex-wrap gap-2">{locations.map((location) => <span key={location} className="border border-border px-2 py-1 font-mono text-[8px] text-muted-foreground">{location}</span>)}</div></ReportSection>}
    <ReportSection title="Evidence and validation"><TextBlocks lines={[...evidence, ...validation].slice(0, 7)} fallback="Nenhuma evidência estruturada adicional foi preservada neste artefato." /></ReportSection>
    <ReportSection title="Remediation direction"><TextBlocks lines={remediation} fallback="A execução não registrou orientação estruturada de remediação." /></ReportSection>
    {(finding.severityRationale || finding.confidenceRationale) && <ReportSection title="Rationale"><TextBlocks lines={[finding.severityRationale, finding.confidenceRationale].filter((line): line is string => Boolean(line))} /></ReportSection>}
    <ReportFooter reportId={reportId} />
  </ReportSheet>;
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-6 border-t border-border pt-5"><Kicker>{title}</Kicker><div className="mt-3">{children}</div></section>;
}

function TextBlocks({ lines, fallback }: { lines: string[]; fallback?: string }) {
  const content = lines.length ? lines : fallback ? [fallback] : [];
  return <div className="space-y-2">{content.map((line, index) => <p key={`${line}-${index}`} className="text-[11px] leading-5 text-muted-foreground">{line}</p>)}</div>;
}

function sortFindings(findings: FindingDetail[]): FindingDetail[] {
  return [...findings].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || a.title.localeCompare(b.title));
}

function chunk<T>(items: T[], size: number): T[][] {
  if (!items.length) return [[]];
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));
}

function flattenText(value: unknown, limit: number): string[] {
  const collected: string[] = [];
  const visit = (entry: unknown) => {
    if (collected.length >= limit || entry == null) return;
    if (typeof entry === "string") {
      const clean = entry.trim();
      if (clean && !collected.includes(clean)) collected.push(clean);
      return;
    }
    if (typeof entry === "number" || typeof entry === "boolean") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (typeof entry === "object") Object.values(entry as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return collected;
}

function locationList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    const lines = typeof record.lines === "string" || typeof record.lines === "number" ? `:${record.lines}` : "";
    return `${path}${lines}`;
  }).filter(Boolean))].slice(0, 10);
}
