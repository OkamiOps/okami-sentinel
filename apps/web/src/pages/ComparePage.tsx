import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  ArrowRight01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from "recharts";
import type {
  CompareFindingChange,
  CompareFindingDelta,
  CompareResult,
  ScanRun,
  Severity,
  SeverityCounts,
} from "@csb/shared";
import { api } from "../api";
import {
  AlertBanner,
  EmptyState,
  LiveDuration,
  PageHeader,
  Panel,
  SeverityBadge,
  SeverityStrip,
  cx,
} from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatDuration, formatTokens, formatUsd, shortId } from "../format";
import { buildDecisionRanking, buildMarginalEconomics, type CompareObjective, type ScanDecisionRow } from "../lib/compare-decision";

const changeOrder: CompareFindingChange[] = [
  "candidate_only",
  "severity_changed",
  "baseline_only",
  "both",
];
const changeLabel: Record<CompareFindingChange, string> = {
  candidate_only: "só candidato",
  baseline_only: "só baseline",
  both: "em ambos",
  severity_changed: "severidade diferente",
};
const changeTone: Record<CompareFindingChange, string> = {
  candidate_only: "border-primary/45 bg-primary/10 text-primary",
  baseline_only: "border-chart-3/45 bg-chart-3/10 text-chart-3",
  both: "border-chart-2/45 bg-chart-2/10 text-chart-2",
  severity_changed: "border-chart-3/45 bg-chart-3/10 text-chart-3",
};
const severityRows: Array<[keyof SeverityCounts, string]> = [
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["info", "Info"],
  ["total", "Total"],
];
const objectives: Array<{ id: CompareObjective; label: string; description: string }> = [
  { id: "balanced", label: "Equilíbrio", description: "Cobertura 30% · High+ 25% · $/finding 20% · $/High+ 15% · velocidade 10%" },
  { id: "coverage", label: "Cobertura", description: "Maior volume total reportado" },
  { id: "high_plus", label: "High+", description: "Maior volume crítico + alto" },
  { id: "cost_per_finding", label: "$ / finding", description: "Menor custo por achado reportado" },
  { id: "cost_per_high", label: "$ / High+", description: "Menor custo por achado prioritário" },
  { id: "speed", label: "Velocidade", description: "Menor duração medida" },
];
const scanChartColors = ["var(--primary)", "var(--chart-3)", "var(--chart-2)", "var(--chart-4)", "var(--chart-5)"];

export function ComparePage() {
  const [params] = useSearchParams();
  const [scans, setScans] = useState<ScanRun[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .listScans()
      .then(({ scans: all }) => {
        const complete = all.filter((scan) => scan.status === "completed");
        setScans(complete);
        const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
        setSelected(ids.filter((id) => complete.some((scan) => scan.id === id)).slice(0, 5));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Falha ao listar scans"));
  }, [params]);

  const chosen = useMemo(
    () => selected.map((id) => scans.find((scan) => scan.id === id)).filter((scan): scan is ScanRun => Boolean(scan)),
    [selected, scans],
  );

  function toggle(id: string) {
    if (!selected.includes(id) && selected.length >= 5) {
      setError("O comparador aceita um baseline e até quatro candidatos por vez.");
      return;
    }
    setError(null);
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current, id];
    });
    setResult(null);
  }

  function promoteToBaseline(id: string) {
    setSelected((current) => [id, ...current.filter((item) => item !== id)]);
    setResult(null);
  }

  async function compare() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.compare({ scanIds: selected }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Falha na comparação");
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <PageHeader
      code="05 / COMPARE"
      title="Diff de segurança"
      description="Escolha um baseline e até quatro candidatos. O cockpit aponta o vencedor por objetivo; o diff mostra exatamente onde as execuções divergem."
      actions={result ? <Button variant="outline" onClick={() => setResult(null)}>ALTERAR SCANS</Button> : <Button onClick={() => void compare()} disabled={busy || selected.length < 2}>
        <HugeiconsIcon icon={Analytics01Icon} size={13} />
        {busy ? "CALCULANDO DIFF…" : `COMPARAR ${selected.length} SCANS`}
      </Button>}
    />
    {error && <AlertBanner>{error}</AlertBanner>}
    {!result && <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel className="order-2 xl:order-1" label="RUN LIBRARY" title={`${scans.length} scans concluídos`} aside={<span className="font-mono text-[8px] text-muted-foreground">SELECIONE 2–5</span>}>
        {scans.length ? <div className="grid md:grid-cols-2 xl:max-h-[32rem] xl:overflow-auto">
          {scans.map((scan) => {
            const position = selected.indexOf(scan.id);
            const active = position >= 0;
            return <button
              key={scan.id}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(scan.id)}
              className={cx(
                "grid min-h-32 grid-cols-[2rem_minmax(0,1fr)] gap-3 border-b p-4 text-left transition md:nth-[odd]:border-r",
                active ? "bg-accent shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-accent/60",
              )}
            >
              <span className={cx("flex size-6 items-center justify-center border font-mono text-[9px]", active ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}>
                {active ? <HugeiconsIcon icon={Tick02Icon} size={12} /> : "+"}
              </span>
              <span className="min-w-0">
                <span className="flex items-start justify-between gap-3">
                  <span className="truncate text-sm font-semibold">{scan.displayName}</span>
                  {active && <span className="shrink-0 font-mono text-[8px] text-primary">{position === 0 ? "BASELINE" : `CANDIDATO ${String(position).padStart(2, "0")}`}</span>}
                </span>
                <span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">{scan.model}/{scan.effort}/{scan.mode}</span>
                <span className="mt-4 block"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></span>
                <span className="mt-2 grid grid-cols-3 font-mono text-[9px]">
                  <span>{formatUsd(scan.cost?.estimatedUsd)}</span>
                  <span className="text-destructive">{scan.severity.critical + scan.severity.high} high+</span>
                  <span className="text-right text-muted-foreground">{scan.severity.total} total</span>
                </span>
              </span>
            </button>;
          })}
        </div> : <EmptyState title="Nenhum scan concluído" description="Conclua dois scans para produzir um diff de segurança." />}
      </Panel>
      <Panel className="order-1 h-fit xl:order-2 xl:sticky xl:top-24" label="DIFF INPUT" title="Ordem da comparação">
        <CompareSlot role="BASELINE" scan={chosen[0]} onRemove={() => chosen[0] && toggle(chosen[0].id)} />
        <div className="flex h-10 items-center justify-center border-b bg-muted/20">
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="rotate-90 text-primary xl:rotate-0" />
        </div>
        <div className="max-h-72 overflow-auto">
          {chosen.slice(1).map((scan, index) => <CompareSlot key={scan.id} role={`CANDIDATO ${String(index + 1).padStart(2, "0")}`} scan={scan} onRemove={() => toggle(scan.id)} onPromote={() => promoteToBaseline(scan.id)} />)}
          {chosen.length < 2 && <div className="p-4 text-xs leading-relaxed text-muted-foreground">Selecione ao menos um candidato. Você pode conectar até quatro.</div>}
        </div>
        <div className="border-t p-3">
          <Button className="w-full" onClick={() => void compare()} disabled={chosen.length < 2 || busy}>Executar diff de {chosen.length} scans</Button>
        </div>
      </Panel>
    </div>}
    {result && <ComparisonOutput result={result} />}
  </div>;
}

function CompareSlot({ role, scan, onRemove, onPromote }: { role: string; scan?: ScanRun; onRemove: () => void; onPromote?: () => void }) {
  return <div className="min-h-28 p-4">
    <div className="bench-label text-primary">{role}</div>
    {scan ? <div className="mt-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="truncate text-sm font-semibold">{scan.displayName}</div><div className="mt-1 truncate font-mono text-[8px] text-muted-foreground">{shortId(scan.id)} · {formatDate(scan.startedAt)}</div></div>
        <div className="flex shrink-0 flex-col items-end gap-1">{onPromote && <button type="button" onClick={onPromote} className="font-mono text-[7px] uppercase text-primary hover:text-foreground">usar baseline</button>}<button type="button" onClick={onRemove} className="font-mono text-[8px] uppercase text-muted-foreground hover:text-destructive">remover</button></div>
      </div>
    </div> : <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Selecione um scan na biblioteca.</p>}
  </div>;
}

function ComparisonOutput({ result }: { result: CompareResult }) {
  const baseline = result.scans.find((scan) => scan.id === result.baselineScanId);
  const [activeCandidateId, setActiveCandidateId] = useState(result.candidateScanIds[0] ?? "");
  const [objective, setObjective] = useState<CompareObjective>("balanced");
  const [change, setChange] = useState<CompareFindingChange | "all">("all");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [query, setQuery] = useState("");
  useEffect(() => {
    setActiveCandidateId(result.candidateScanIds[0] ?? "");
    setObjective("balanced");
    setChange("all");
    setSeverity("all");
    setQuery("");
  }, [result]);
  const decisionRanking = useMemo(() => buildDecisionRanking(result.scans, objective), [result.scans, objective]);
  const comparison = result.comparisons.find((item) => item.candidateScanId === activeCandidateId);
  const candidate = result.scans.find((scan) => scan.id === activeCandidateId);
  const pairFindings = comparison?.findings ?? [];
  const filtered = useMemo(() => pairFindings.filter((finding) => {
    const occurrence = finding.candidate ?? finding.baseline;
    const haystack = `${finding.title} ${occurrence?.summary} ${occurrence?.primaryPath} ${occurrence?.category} ${occurrence?.ruleId} ${occurrence?.cwe.join(" ")}`.toLowerCase();
    return (change === "all" || finding.change === change)
      && (severity === "all" || occurrence?.severity === severity)
      && haystack.includes(query.toLowerCase());
  }), [pairFindings, change, severity, query]);

  if (!baseline || !candidate || !comparison) return null;
  const baselineHigh = baseline.severity.critical + baseline.severity.high;
  const candidateHigh = candidate.severity.critical + candidate.severity.high;
  const highDelta = candidateHigh - baselineHigh;
  const sameRepository = normalizePath(baseline.repositoryPath) === normalizePath(candidate.repositoryPath);
  function selectCandidate(id: string) {
    setActiveCandidateId(id);
    setChange("all");
    setSeverity("all");
    setQuery("");
  }

  return <section className="mt-6">
    <div className="mb-3 flex items-center gap-3"><span className="bench-label text-primary">SECURITY CHANGESET / READY</span><span className="h-px flex-1 bg-border" /><span className="font-mono text-[8px] text-muted-foreground">{result.scans.length} SCANS · 1 BASELINE · {result.candidateScanIds.length} CANDIDATOS</span></div>
    <AlertBanner tone="info"><strong>Leitura de cobertura, não de remediação.</strong> “Só baseline” significa que o candidato não reportou o sinal; isso não prova que a vulnerabilidade foi corrigida. Da mesma forma, “só candidato” não significa que ela surgiu agora.</AlertBanner>
    {!sameRepository && <AlertBanner tone="warning">Os scans pertencem a alvos diferentes. O diff continua disponível, mas sinais exclusivos podem refletir aplicações diferentes, não regressões.</AlertBanner>}
    <DecisionCockpit ranking={decisionRanking} objective={objective} onObjectiveChange={setObjective} />
    <UnitEconomicsSummary rows={decisionRanking} baselineScanId={result.baselineScanId} />
    <ComparisonCharts result={result} rows={decisionRanking} activeCandidateId={activeCandidateId} onSelectCandidate={selectCandidate} />
    <DetectionScoreboard ranking={decisionRanking} objective={objective} baselineScanId={result.baselineScanId} activeCandidateId={activeCandidateId} onSelect={selectCandidate} />
    <CandidateRail result={result} activeCandidateId={activeCandidateId} onSelect={selectCandidate} />
    <div className="bench-panel bench-corners">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_16rem_minmax(0,1fr)]">
        <RunReadout role="BASELINE" scan={baseline} />
        <div className="flex min-h-40 flex-col items-center justify-center border-b p-5 text-center lg:border-x lg:border-b-0">
          <div className="bench-label">DETECTION DELTA / HIGH+</div>
          <div className={cx("mt-2 font-mono text-4xl font-semibold tabular-nums", highDelta > 0 ? "text-destructive" : highDelta < 0 ? "text-chart-2" : "text-muted-foreground")}>{signed(highDelta)}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">{highDelta > 0 ? `candidato reportou ${highDelta} high+ a mais` : highDelta < 0 ? `candidato reportou ${Math.abs(highDelta)} high+ a menos` : "mesma contagem de high+"}</div>
        </div>
        <RunReadout role="CANDIDATO" scan={candidate} />
      </div>
      <div className="grid grid-cols-2 border-t xl:grid-cols-4">
        {changeOrder.map((item) => <button key={item} type="button" onClick={() => setChange((current) => current === item ? "all" : item)} className={cx("border-b border-r p-4 text-left transition hover:bg-accent", change === item && "bg-accent shadow-[inset_0_-2px_0_var(--primary)]")}>
          <div className={cx("font-mono text-[9px] uppercase tracking-wider", changeTone[item].split(" ").at(-1))}>{changeLabel[item]}</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{comparison.counts[item]}</div>
        </button>)}
      </div>
    </div>

    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
      <SeverityLedger baseline={baseline} candidate={candidate} />
      <OperationalLedger result={result} baseline={baseline} candidate={candidate} />
    </div>

    <Panel className="mt-4" label="OBSERVATION DIFF" title={`${filtered.length} de ${pairFindings.length} sinais comparados · ${candidate.displayName}`} aside={<span className="font-mono text-[8px] text-muted-foreground">EXPANDA UMA LINHA PARA INSPECIONAR</span>} wrapTitle>
      <div className="grid gap-2 border-b p-3 md:grid-cols-[minmax(14rem,1fr)_11rem_10rem]">
        <label className="flex h-9 items-center gap-2 border bg-background px-3">
          <HugeiconsIcon icon={Search01Icon} size={12} className="text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Título, caminho, regra, CWE…" className="h-8 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0" />
        </label>
        <Select value={change} onValueChange={(value) => setChange(value as CompareFindingChange | "all")}>
          <SelectTrigger className="h-9 rounded-none font-mono text-[9px] uppercase"><SelectValue /></SelectTrigger>
          <SelectContent className="rounded-none"><SelectItem value="all">Toda cobertura</SelectItem>{changeOrder.map((item) => <SelectItem key={item} value={item}>{changeLabel[item]}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={severity} onValueChange={(value) => setSeverity(value as Severity | "all")}>
          <SelectTrigger className="h-9 rounded-none font-mono text-[9px] uppercase"><SelectValue /></SelectTrigger>
          <SelectContent className="rounded-none"><SelectItem value="all">Toda severidade</SelectItem>{(["critical", "high", "medium", "low", "info"] as Severity[]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="hidden grid-cols-[8rem_9rem_minmax(18rem,1fr)_11rem] border-b px-4 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground lg:grid"><span>Cobertura</span><span>Severidade</span><span>Vulnerabilidade / evidência</span><span>Presença</span></div>
      <div>{filtered.map((finding) => <FindingDiffRow key={finding.key} finding={finding} />)}{filtered.length === 0 && <EmptyState title="Nenhuma vulnerabilidade neste recorte" description="Remova filtros ou altere a busca para ampliar o diff." />}</div>
    </Panel>
  </section>;
}

function CandidateRail({ result, activeCandidateId, onSelect }: { result: CompareResult; activeCandidateId: string; onSelect: (id: string) => void }) {
  const baseline = result.scans.find((scan) => scan.id === result.baselineScanId);
  const baselineHigh = baseline ? baseline.severity.critical + baseline.severity.high : 0;
  return <Panel className="mb-4" label="CANDIDATE CHANNELS" title="Escolha o diff detalhado" aside={<span className="font-mono text-[8px] text-muted-foreground">TODOS PERMANECEM NO RANKING</span>} wrapTitle>
    <div className="grid grid-cols-2 xl:grid-cols-4">
      {result.candidateScanIds.map((id, index) => {
        const scan = result.scans.find((item) => item.id === id);
        const comparison = result.comparisons.find((item) => item.candidateScanId === id);
        if (!scan || !comparison) return null;
        const highDelta = scan.severity.critical + scan.severity.high - baselineHigh;
        return <button key={id} type="button" aria-pressed={activeCandidateId === id} onClick={() => onSelect(id)} className={cx("min-w-0 border-b border-r p-4 text-left transition hover:bg-accent/60", activeCandidateId === id && "bg-accent shadow-[inset_0_-2px_0_var(--primary)]")}>
          <div className="flex items-center justify-between gap-2"><span className="font-mono text-[8px] text-primary">C-{String(index + 1).padStart(2, "0")}</span><span className={cx("font-mono text-[9px]", highDelta > 0 ? "text-destructive" : highDelta < 0 ? "text-chart-2" : "text-muted-foreground")}>{signed(highDelta)} high+</span></div>
          <div className="mt-2 truncate text-xs font-semibold">{scan.displayName}</div>
          <div className="mt-1 truncate font-mono text-[8px] text-muted-foreground">{scan.model}/{scan.effort}/{scan.mode}</div>
          <div className="mt-3 flex gap-3 font-mono text-[8px]"><span className="text-primary">{comparison.counts.candidate_only} só candidato</span><span className="text-chart-3">{comparison.counts.baseline_only} só baseline</span></div>
        </button>;
      })}
    </div>
  </Panel>;
}

function DecisionCockpit({ ranking, objective, onObjectiveChange }: { ranking: ScanDecisionRow[]; objective: CompareObjective; onObjectiveChange: (objective: CompareObjective) => void }) {
  const winner = ranking[0];
  const runnerUp = ranking[1];
  const meta = objectives.find((item) => item.id === objective) ?? objectives[0];
  if (!winner) return null;
  return <Panel className="mt-4 overflow-hidden" label="DECISION COCKPIT" title="Qual execução foi melhor para o seu objetivo?" aside={<span className="font-mono text-[8px] text-muted-foreground">CRITÉRIO EXPLÍCITO · SEM CHUTE DE PRECISÃO</span>} wrapTitle>
    <div className="flex flex-col gap-2 border-b bg-muted/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="bench-label text-primary">ESCOLHA O CRITÉRIO DE DECISÃO</div>
        <p className="mt-1 text-[10px] text-muted-foreground">Clique em uma opção para recalcular o vencedor e o ranking completo.</p>
      </div>
      <div className="flex w-fit items-center gap-2 border border-primary/35 bg-primary/[.06] px-3 py-1.5 font-mono text-[8px] uppercase tracking-wider text-primary">
        <span className="size-1.5 bg-primary" />
        Critério atual: {meta.label}
      </div>
    </div>
    <div className="grid border-b sm:grid-cols-2 xl:grid-cols-6">
      {objectives.map((item) => {
        const active = objective === item.id;
        return <button
          key={item.id}
          type="button"
          aria-pressed={active}
          onClick={() => onObjectiveChange(item.id)}
          className={cx(
            "group relative min-h-28 cursor-pointer border-b border-r px-4 py-3 text-left transition-all focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
            active
              ? "bg-primary/[.08] shadow-[inset_0_3px_0_var(--primary)]"
              : "hover:bg-primary/[.04] hover:shadow-[inset_0_3px_0_color-mix(in_oklab,var(--primary)_45%,transparent)]",
          )}
        >
          <span className="flex items-center justify-between gap-3">
            <span className={cx("font-mono text-[9px] uppercase tracking-wider", active ? "text-primary" : "text-foreground")}>{item.label}</span>
            <span className={cx("flex size-4 shrink-0 items-center justify-center border transition-colors", active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 group-hover:border-primary")}>
              {active && <HugeiconsIcon icon={Tick02Icon} size={11} />}
            </span>
          </span>
          <span className="mt-2 block text-[9px] leading-snug text-muted-foreground">{item.description}</span>
          <span className={cx("mt-3 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider transition-colors", active ? "text-primary" : "text-muted-foreground group-hover:text-primary")}>
            {active ? "Selecionado" : "Selecionar"}
            {!active && <HugeiconsIcon icon={ArrowRight01Icon} size={10} className="transition-transform group-hover:translate-x-0.5" />}
          </span>
        </button>;
      })}
    </div>
    <div className="grid xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)]">
      <div className="relative min-h-72 overflow-hidden border-b p-6 xl:border-b-0 xl:border-r">
        <div className="pointer-events-none absolute -right-8 -top-12 font-mono text-[12rem] font-semibold leading-none text-primary/[.035]">01</div>
        <div className="bench-label text-primary">VENCEDOR / {meta.label}</div>
        <div className="mt-4 max-w-3xl font-heading text-3xl font-semibold tracking-[-.045em] sm:text-5xl">{decisionProfile(winner.scan)}</div>
        <div className="mt-2 font-mono text-[9px] text-muted-foreground">{winner.scan.displayName} · {shortId(winner.scan.id)}</div>
        <p className="mt-5 max-w-2xl text-sm leading-relaxed text-foreground/80">{decisionReason(winner, objective)}</p>
        <div className="mt-6 grid grid-cols-2 border sm:grid-cols-4">
          <DecisionMetric label="RESULTADO" value={decisionValue(winner, objective)} accent />
          <DecisionMetric label="TOTAL" value={String(winner.total)} />
          <DecisionMetric label="HIGH+" value={String(winner.highPlus)} />
          <DecisionMetric label="CUSTO" value={formatUsd(winner.costUsd)} />
          <DecisionMetric label="$ / FINDING" value={formatUsd(winner.costPerFinding)} />
          <DecisionMetric label="$ / HIGH+" value={formatUsd(winner.costPerHighPlus)} />
          <DecisionMetric label="FINDINGS / H" value={formatRate(winner.findingsPerHour)} />
          <DecisionMetric label="DURAÇÃO" value={formatDuration(winner.durationMs)} />
        </div>
        {runnerUp && <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] text-muted-foreground"><span>2º LUGAR</span><span className="text-foreground">{decisionProfile(runnerUp.scan)}</span><span>{decisionValue(runnerUp, objective)}</span></div>}
      </div>
      <div className="flex flex-col justify-between bg-muted/10 p-6">
        <div>
          <div className="bench-label text-chart-3">LIMITE DA LEITURA</div>
          <div className="mt-4 font-heading text-2xl font-semibold tracking-[-.035em]">Precisão ainda não é mensurável.</div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">O ranking mede o que cada execução reportou, quanto custou e quanto demorou. Sem findings confirmados e falsos positivos triados, nenhum scan pode ser chamado de “mais correto”.</p>
        </div>
        <div className="mt-8 border-l-2 border-chart-3 pl-4">
          <div className="font-mono text-[8px] uppercase tracking-wider text-chart-3">COMO VALIDAR QUALIDADE REAL</div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Confirme uma amostra, marque falso positivo/verdadeiro positivo e use esse conjunto como ground truth. Aí o produto poderá calcular precisão, recall e F1 sem vender ficção.</p>
        </div>
      </div>
    </div>
  </Panel>;
}

function DecisionMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-0 border-r p-3"><div className="bench-label">{label}</div><div className={cx("mt-2 truncate font-mono text-sm font-semibold", accent && "text-primary")}>{value}</div></div>;
}

function UnitEconomicsSummary({ rows, baselineScanId }: { rows: ScanDecisionRow[]; baselineScanId: string }) {
  const bestFinding = [...rows].filter((row) => row.costPerFinding != null).sort((left, right) => (left.costPerFinding ?? Infinity) - (right.costPerFinding ?? Infinity))[0];
  const bestHigh = [...rows].filter((row) => row.costPerHighPlus != null).sort((left, right) => (left.costPerHighPlus ?? Infinity) - (right.costPerHighPlus ?? Infinity))[0];
  const bestThroughput = [...rows].filter((row) => row.findingsPerHour != null).sort((left, right) => (right.findingsPerHour ?? 0) - (left.findingsPerHour ?? 0))[0];
  const marginal = buildMarginalEconomics(rows, baselineScanId);
  const bestMarginal = [...marginal].filter((row) => row.costPerExtraFinding != null).sort((left, right) => (left.costPerExtraFinding ?? Infinity) - (right.costPerExtraFinding ?? Infinity))[0];
  const bestMarginalScan = rows.find((row) => row.scan.id === bestMarginal?.scanId);
  const bestMarginalHigh = [...marginal].filter((row) => row.costPerExtraHighPlus != null).sort((left, right) => (left.costPerExtraHighPlus ?? Infinity) - (right.costPerExtraHighPlus ?? Infinity))[0];
  const bestMarginalHighScan = rows.find((row) => row.scan.id === bestMarginalHigh?.scanId);
  return <Panel className="mt-4" label="UNIT ECONOMICS" title="Quem extraiu mais sinal de cada dólar e de cada hora" aside={<span className="font-mono text-[8px] text-muted-foreground">MENOR CUSTO UNITÁRIO = MELHOR</span>} wrapTitle>
    <div className="grid sm:grid-cols-2 xl:grid-cols-5">
      <EconomicsLeader label="MENOR $ / FINDING" row={bestFinding} value={formatUsd(bestFinding?.costPerFinding)} detail={bestFinding ? `${bestFinding.total} achados por ${formatUsd(bestFinding.costUsd)}` : "Sem custo mensurado"} />
      <EconomicsLeader label="MENOR $ / HIGH+" row={bestHigh} value={formatUsd(bestHigh?.costPerHighPlus)} detail={bestHigh ? `${bestHigh.highPlus} High+ por ${formatUsd(bestHigh.costUsd)}` : "Nenhum High+ com custo"} />
      <EconomicsLeader label="MENOR $ MARGINAL" row={bestMarginalScan} value={formatUsd(bestMarginal?.costPerExtraFinding)} detail={bestMarginal ? `+${bestMarginal.extraFindings} achados por ${formatUsd(bestMarginal.extraCostUsd)} vs baseline` : "Sem ganho adicional mensurável"} />
      <EconomicsLeader label="MENOR $ / HIGH+ EXTRA" row={bestMarginalHighScan} value={formatUsd(bestMarginalHigh?.costPerExtraHighPlus)} detail={bestMarginalHigh ? `+${bestMarginalHigh.extraHighPlus} High+ por ${formatUsd(bestMarginalHigh.extraCostUsd)} vs baseline` : "Sem High+ adicional mensurável"} />
      <EconomicsLeader label="MAIOR THROUGHPUT" row={bestThroughput} value={bestThroughput ? `${formatRate(bestThroughput.findingsPerHour)} / h` : "—"} detail={bestThroughput ? `${bestThroughput.total} achados em ${formatDuration(bestThroughput.durationMs)}` : "Sem duração mensurada"} />
    </div>
    <div className="border-t px-4 py-3 text-[9px] leading-relaxed text-muted-foreground">Todos os custos usam findings reportados, antes de confirmação ou remoção de falsos positivos. Por isso $/finding mede economia operacional, não precisão.</div>
  </Panel>;
}

function EconomicsLeader({ label, row, value, detail }: { label: string; row?: ScanDecisionRow; value: string; detail: string }) {
  return <div className="min-h-36 border-b border-r p-4">
    <div className="bench-label text-primary">{label}</div>
    <div className="mt-3 font-mono text-2xl font-semibold tracking-[-.04em]">{value}</div>
    <div className="mt-3 truncate text-xs font-semibold">{row ? decisionProfile(row.scan) : "Sem vencedor"}</div>
    <div className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{detail}</div>
  </div>;
}

function ComparisonCharts({ result, rows, activeCandidateId, onSelectCandidate }: { result: CompareResult; rows: ScanDecisionRow[]; activeCandidateId: string; onSelectCandidate: (id: string) => void }) {
  const severityData = result.scans.map((scan) => ({
    scanId: scan.id,
    label: chartProfile(scan),
    critical: scan.severity.critical,
    high: scan.severity.high,
    medium: scan.severity.medium,
    low: scan.severity.low,
    info: scan.severity.info,
    total: scan.severity.total,
  }));
  const scatterData = result.scans.filter((scan) => scan.cost?.estimatedUsd != null).map((scan, index) => ({
    scanId: scan.id,
    label: chartProfile(scan),
    cost: scan.cost?.estimatedUsd ?? 0,
    total: scan.severity.total,
    highPlus: scan.severity.critical + scan.severity.high,
    color: scanChartColors[index % scanChartColors.length],
  }));
  const agreementData = result.comparisons.map((comparison) => {
    const scan = result.scans.find((item) => item.id === comparison.candidateScanId);
    return {
      scanId: comparison.candidateScanId,
      label: `${comparison.candidateScanId === activeCandidateId ? "● " : ""}${scan ? chartProfile(scan) : shortId(comparison.candidateScanId)}`,
      candidateOnly: comparison.counts.candidate_only,
      shared: comparison.counts.both + comparison.counts.severity_changed,
      baselineOnly: comparison.counts.baseline_only,
    };
  });
  const unitData = result.scans.map((scan) => {
    const row = rows.find((item) => item.scan.id === scan.id);
    return {
      scanId: scan.id,
      label: chartProfile(scan),
      costPerFinding: row?.costPerFinding ?? null,
      costPerHighPlus: row?.costPerHighPlus ?? null,
    };
  });
  const marginalData = buildMarginalEconomics(rows, result.baselineScanId).map((marginal) => {
    const scan = result.scans.find((item) => item.id === marginal.scanId);
    return {
      ...marginal,
      label: scan ? chartProfile(scan) : shortId(marginal.scanId),
    };
  });
  const severityHeight = Math.max(280, severityData.length * 58);
  const agreementHeight = Math.max(240, agreementData.length * 62);
  const economicsHeight = Math.max(280, unitData.length * 58);
  return <div className="mt-4 grid gap-4 xl:grid-cols-2">
    <Panel label="SEVERITY PROFILE" title="Composição do que cada scan reportou" aside={<span className="font-mono text-[8px] text-muted-foreground">VALORES ABSOLUTOS</span>} wrapTitle>
      <div style={{ height: severityHeight }} className="px-2 py-4">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={severityData} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 16 }}>
          <CartesianGrid horizontal={false} strokeDasharray="2 5" />
          <XAxis type="number" axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={104} />
          <RechartsTooltip content={(props) => <DecisionChartTooltip {...props} />} cursor={{ fill: "var(--accent)", fillOpacity: 0.35 }} />
          <Legend iconType="square" verticalAlign="top" align="right" wrapperStyle={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
          <Bar dataKey="critical" name="Critical" stackId="severity" fill="var(--destructive)" />
          <Bar dataKey="high" name="High" stackId="severity" fill="var(--chart-4)" />
          <Bar dataKey="medium" name="Medium" stackId="severity" fill="var(--chart-3)" />
          <Bar dataKey="low" name="Low" stackId="severity" fill="var(--chart-5)" />
          <Bar dataKey="info" name="Info" stackId="severity" fill="var(--chart-2)" />
        </BarChart></ResponsiveContainer>
      </div>
    </Panel>
    <Panel label="COST × COVERAGE" title="Quanto de cobertura foi comprado" aside={<span className="font-mono text-[8px] text-muted-foreground">MELHOR ZONA: ALTO E À ESQUERDA</span>} wrapTitle>
      <div className="grid border-b sm:grid-cols-2 xl:grid-cols-3">{scatterData.map((point) => <button key={point.scanId} type="button" disabled={point.scanId === result.baselineScanId} onClick={() => onSelectCandidate(point.scanId)} className={cx("flex min-w-0 items-center gap-2 border-b border-r px-3 py-2 text-left hover:bg-accent/60 disabled:cursor-default", point.scanId === activeCandidateId && "bg-accent")}><span className="size-2 shrink-0" style={{ background: point.color }} /><span className="min-w-0"><span className="block truncate font-mono text-[8px] text-foreground">{point.label}</span><span className="mt-0.5 block font-mono text-[7px] text-muted-foreground">{formatUsd(point.cost)} · {point.total} achados · {point.highPlus} High+</span></span></button>)}</div>
      <div className="h-[22rem] px-2 py-4">
        <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 18, right: 24, bottom: 12, left: 0 }}>
          <CartesianGrid strokeDasharray="2 5" />
          <XAxis type="number" dataKey="cost" name="Custo USD" axisLine={false} tickLine={false} tickFormatter={(value) => `$${Number(value).toFixed(0)}`} />
          <YAxis type="number" dataKey="total" name="Achados" axisLine={false} tickLine={false} allowDecimals={false} />
          <ZAxis type="number" dataKey="highPlus" range={[90, 360]} name="High+" />
          <RechartsTooltip content={(props) => <DecisionChartTooltip {...props} />} cursor={{ strokeDasharray: "3 3" }} />
          <Scatter name="Scans" data={scatterData} fill="var(--primary)">
            {scatterData.map((point) => <Cell key={point.scanId} fill={point.color} stroke={point.scanId === activeCandidateId ? "var(--foreground)" : "var(--background)"} strokeWidth={point.scanId === activeCandidateId ? 3 : 2} />)}
          </Scatter>
        </ScatterChart></ResponsiveContainer>
      </div>
      <div className="border-t px-4 py-3 text-[9px] leading-relaxed text-muted-foreground">Tamanho do ponto = High+. O gráfico compara eficiência visualmente; não mede falsos positivos.</div>
    </Panel>
    <Panel label="UNIT COST" title="Quanto custou cada finding reportado" aside={<span className="font-mono text-[8px] text-muted-foreground">MENOR É MELHOR</span>} wrapTitle>
      <div style={{ height: economicsHeight }} className="px-2 py-4">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={unitData} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 16 }}>
          <CartesianGrid horizontal={false} strokeDasharray="2 5" />
          <XAxis type="number" axisLine={false} tickLine={false} tickFormatter={(value) => `$${Number(value).toFixed(2)}`} />
          <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={104} />
          <RechartsTooltip content={(props) => <DecisionChartTooltip {...props} />} cursor={{ fill: "var(--accent)", fillOpacity: 0.35 }} />
          <Legend iconType="square" verticalAlign="top" align="right" wrapperStyle={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
          <Bar dataKey="costPerFinding" name="$ / finding" fill="var(--primary)" onClick={(entry) => typeof entry.payload?.scanId === "string" && entry.payload.scanId !== result.baselineScanId && onSelectCandidate(entry.payload.scanId)} />
          <Bar dataKey="costPerHighPlus" name="$ / High+" fill="var(--chart-3)" onClick={(entry) => typeof entry.payload?.scanId === "string" && entry.payload.scanId !== result.baselineScanId && onSelectCandidate(entry.payload.scanId)} />
        </BarChart></ResponsiveContainer>
      </div>
      <div className="border-t px-4 py-3 text-[9px] leading-relaxed text-muted-foreground">Sem barra em $/High+ significa que o scan não reportou Critical ou High; não significa custo zero.</div>
    </Panel>
    <Panel label="MARGINAL RETURN" title="Custo de cada achado adicional contra o baseline" aside={<span className="font-mono text-[8px] text-muted-foreground">Δ CUSTO / Δ ACHADOS</span>} wrapTitle>
      <div style={{ height: economicsHeight }} className="px-2 py-4">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={marginalData} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 16 }}>
          <CartesianGrid horizontal={false} strokeDasharray="2 5" />
          <XAxis type="number" axisLine={false} tickLine={false} tickFormatter={(value) => `$${Number(value).toFixed(2)}`} />
          <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={104} />
          <RechartsTooltip content={(props) => <DecisionChartTooltip {...props} />} cursor={{ fill: "var(--accent)", fillOpacity: 0.35 }} />
          <Legend iconType="square" verticalAlign="top" align="right" wrapperStyle={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
          <Bar dataKey="costPerExtraFinding" name="$ / finding extra" fill="var(--chart-2)" onClick={(entry) => typeof entry.payload?.scanId === "string" && onSelectCandidate(entry.payload.scanId)} />
          <Bar dataKey="costPerExtraHighPlus" name="$ / High+ extra" fill="var(--chart-4)" onClick={(entry) => typeof entry.payload?.scanId === "string" && onSelectCandidate(entry.payload.scanId)} />
        </BarChart></ResponsiveContainer>
      </div>
      <div className="border-t px-4 py-3 text-[9px] leading-relaxed text-muted-foreground">Métrica marginal só existe quando o candidato custa mais e reporta achados adicionais ao baseline.</div>
    </Panel>
    <Panel className="xl:col-span-2" label="BASELINE AGREEMENT" title="O que cada candidato compartilha — ou não — com o baseline" aside={<span className="font-mono text-[8px] text-muted-foreground">CONCORDÂNCIA ≠ VERDADE</span>} wrapTitle>
      <div style={{ height: agreementHeight }} className="px-2 py-4">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={agreementData} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 16 }}>
          <CartesianGrid horizontal={false} strokeDasharray="2 5" />
          <XAxis type="number" axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={112} />
          <RechartsTooltip content={(props) => <DecisionChartTooltip {...props} />} cursor={{ fill: "var(--accent)", fillOpacity: 0.35 }} />
          <Legend iconType="square" verticalAlign="top" align="right" wrapperStyle={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
          <Bar dataKey="shared" name="Em ambos" stackId="agreement" fill="var(--chart-2)" onClick={(entry) => typeof entry.payload?.scanId === "string" && onSelectCandidate(entry.payload.scanId)} />
          <Bar dataKey="candidateOnly" name="Só candidato" stackId="agreement" fill="var(--primary)" onClick={(entry) => typeof entry.payload?.scanId === "string" && onSelectCandidate(entry.payload.scanId)} />
          <Bar dataKey="baselineOnly" name="Só baseline" stackId="agreement" fill="var(--chart-3)" onClick={(entry) => typeof entry.payload?.scanId === "string" && onSelectCandidate(entry.payload.scanId)} />
        </BarChart></ResponsiveContainer>
      </div>
    </Panel>
  </div>;
}

function DecisionChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as { label?: string } | undefined;
  return <div className="min-w-36 border bg-popover p-3 shadow-2xl">
    <div className="mb-2 text-xs font-semibold text-foreground">{point?.label ?? "Scan"}</div>
    <div className="space-y-1 font-mono text-[9px]">{payload.map((entry) => <div key={String(entry.dataKey)} className="flex items-center justify-between gap-5"><span style={{ color: entry.color }}>{entry.name}</span><span className="text-foreground">{formatChartValue(entry.value)}</span></div>)}</div>
  </div>;
}

function DetectionScoreboard({ ranking, objective, baselineScanId, activeCandidateId, onSelect }: { ranking: ScanDecisionRow[]; objective: CompareObjective; baselineScanId: string; activeCandidateId: string; onSelect: (id: string) => void }) {
  const meta = objectives.find((item) => item.id === objective) ?? objectives[0];
  const marginalById = new Map(buildMarginalEconomics(ranking, baselineScanId).map((row) => [row.scanId, row]));
  return <Panel className="mt-4" label="DECISION RANKING" title={`Ranking por ${meta.label.toLowerCase()}`} aside={<span className="font-mono text-[8px] text-muted-foreground">MUDE O OBJETIVO ACIMA PARA RECALCULAR</span>} wrapTitle>
    <div className="overflow-x-auto">
      <table className="table min-w-[126rem]">
        <thead><tr className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><th className="sticky left-0 z-20 w-12 bg-background">#</th><th className="sticky left-12 z-20 min-w-60 bg-background">Execução</th><th>Resultado no critério</th><th>Nota relativa</th><th>Total</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>High+</th><th>Custo</th><th>$ / finding</th><th>$ / High+</th><th>Findings / h</th><th>High+ / h</th><th>Δ custo</th><th>$ / finding extra</th><th>$ / High+ extra</th><th>Duração</th></tr></thead>
        <tbody>{ranking.map((row, index) => {
          const scan = row.scan;
          const selectable = scan.id !== baselineScanId;
          const marginal = marginalById.get(scan.id);
          return <tr key={scan.id} className={cx(scan.id === activeCandidateId && "bg-accent")}>
            <td className={cx("sticky left-0 z-10 font-mono text-lg font-semibold", scan.id === activeCandidateId ? "bg-accent" : "bg-background", index === 0 ? "text-primary" : "text-muted-foreground")}>{String(index + 1).padStart(2, "0")}</td>
            <td className={cx("sticky left-12 z-10", scan.id === activeCandidateId ? "bg-accent" : "bg-background")}><button type="button" disabled={!selectable} onClick={() => onSelect(scan.id)} className="max-w-56 text-left disabled:cursor-default"><span className="flex items-center gap-2"><span className="truncate text-xs font-semibold">{decisionProfile(scan)}</span>{index === 0 && <span className="shrink-0 border border-primary/40 px-1.5 py-0.5 font-mono text-[7px] uppercase text-primary">vence</span>}</span><span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">{scan.id === baselineScanId ? "BASELINE" : scan.displayName}</span></button></td>
            <td className="font-mono text-sm font-semibold text-primary">{decisionValue(row, objective)}</td>
            <td><div className="flex items-center gap-3"><div className="h-1.5 w-20 overflow-hidden bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, row.score))}%` }} /></div><span className="font-mono text-[9px]">{row.score.toFixed(0)}</span></div></td>
            <td className="font-mono text-sm font-semibold">{row.total}</td>
            <td className="font-mono text-destructive">{scan.severity.critical}</td>
            <td className="font-mono text-destructive/80">{scan.severity.high}</td>
            <td className="font-mono text-chart-3">{scan.severity.medium}</td>
            <td className="font-mono text-chart-5">{scan.severity.low}</td>
            <td className="font-mono text-destructive">{row.highPlus}</td>
            <td className="font-mono">{formatUsd(row.costUsd)}</td>
            <td className="font-mono text-primary">{formatUsd(row.costPerFinding)}</td>
            <td className="font-mono text-chart-3">{formatUsd(row.costPerHighPlus)}</td>
            <td className="font-mono">{formatRate(row.findingsPerHour)}</td>
            <td className="font-mono">{formatRate(row.highPerHour)}</td>
            <td className="font-mono">{formatSignedUsd(marginal?.extraCostUsd)}</td>
            <td className="font-mono">{formatUsd(marginal?.costPerExtraFinding)}</td>
            <td className="font-mono">{formatUsd(marginal?.costPerExtraHighPlus)}</td>
            <td className="font-mono">{formatDuration(row.durationMs)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="border-t px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">A nota é relativa apenas aos scans selecionados. Ela muda conforme o objetivo e não representa precisão ou taxa de acerto.</div>
  </Panel>;
}

function RunReadout({ role, scan }: { role: string; scan: ScanRun }) {
  return <div className="min-w-0 p-5">
    <div className="bench-label text-primary">{role} / {shortId(scan.id)}</div>
    <div className="mt-2 truncate font-heading text-xl font-semibold tracking-[-.035em]">{scan.displayName}</div>
    <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{scan.model}/{scan.effort}/{scan.mode}</div>
    <div className="mt-5"><SeverityStrip counts={scan.severity} total={scan.severity.total} /></div>
    <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[9px]"><span>{scan.severity.total} findings</span><span className="text-muted-foreground">{formatDate(scan.startedAt)}</span></div>
    <div className="mt-3 truncate border-l border-primary/50 pl-3 font-mono text-[8px] text-muted-foreground">REV / {scan.revision ? shortId(scan.revision) : "unversioned"}</div>
  </div>;
}

function SeverityLedger({ baseline, candidate }: { baseline: ScanRun; candidate: ScanRun }) {
  return <Panel label="PAIRWISE COUNTS" title="Diferença de achados reportados">
    <div className="grid grid-cols-[minmax(6rem,1fr)_5rem_5rem_5rem] border-b px-4 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Severidade</span><span className="text-right">Antes</span><span className="text-right">Δ</span><span className="text-right">Depois</span></div>
    <div>{severityRows.map(([key, label]) => {
      const before = baseline.severity[key];
      const after = candidate.severity[key];
      const delta = after - before;
      return <button key={key} type="button" className="grid w-full grid-cols-[minmax(6rem,1fr)_5rem_5rem_5rem] items-center border-b px-4 py-3 text-left hover:bg-accent/50">
        <span className={cx("font-mono text-[10px] uppercase", key === "critical" && "text-destructive", key === "high" && "text-destructive/80", key === "medium" && "text-chart-3", key === "low" && "text-chart-5", key === "total" && "font-semibold text-foreground")}>{label}</span>
        <span className="text-right font-mono text-sm tabular-nums">{before}</span>
        <span className={cx("text-right font-mono text-sm tabular-nums", delta > 0 ? "text-destructive" : delta < 0 ? "text-chart-2" : "text-muted-foreground")}>{signed(delta)}</span>
        <span className="text-right font-mono text-sm font-semibold tabular-nums">{after}</span>
      </button>;
    })}</div>
  </Panel>;
}

function OperationalLedger({ result, baseline, candidate }: { result: CompareResult; baseline: ScanRun; candidate: ScanRun }) {
  const beforeRank = result.ranking.find((row) => row.scanId === baseline.id);
  const afterRank = result.ranking.find((row) => row.scanId === candidate.id);
  const baselineHigh = baseline.severity.critical + baseline.severity.high;
  const candidateHigh = candidate.severity.critical + candidate.severity.high;
  const baselineCostPerFinding = unitCost(baseline.cost?.estimatedUsd, baseline.severity.total);
  const candidateCostPerFinding = unitCost(candidate.cost?.estimatedUsd, candidate.severity.total);
  const baselineCostPerHigh = unitCost(baseline.cost?.estimatedUsd, baselineHigh);
  const candidateCostPerHigh = unitCost(candidate.cost?.estimatedUsd, candidateHigh);
  const baselineFindingsPerHour = hourlyRate(baseline.severity.total, baseline.durationMs);
  const candidateFindingsPerHour = hourlyRate(candidate.severity.total, candidate.durationMs);
  const rows: Array<[string, ReactNode, ReactNode, ReactNode]> = [
    ["Custo estimado", formatUsd(baseline.cost?.estimatedUsd), moneyDelta(baseline.cost?.estimatedUsd, candidate.cost?.estimatedUsd), formatUsd(candidate.cost?.estimatedUsd)],
    ["USD / finding", formatUsd(baselineCostPerFinding), moneyDelta(baselineCostPerFinding, candidateCostPerFinding), formatUsd(candidateCostPerFinding)],
    ["USD / High+", formatUsd(baselineCostPerHigh), moneyDelta(baselineCostPerHigh, candidateCostPerHigh), formatUsd(candidateCostPerHigh)],
    ["Duração", <LiveDuration startedAt={baseline.startedAt} completedAt={baseline.completedAt} status={baseline.status} durationMs={baseline.durationMs} showDot={false} />, durationDelta(baseline.durationMs, candidate.durationMs), <LiveDuration startedAt={candidate.startedAt} completedAt={candidate.completedAt} status={candidate.status} durationMs={candidate.durationMs} showDot={false} />],
    ["Findings / hora", formatRate(baselineFindingsPerHour), decimalDelta(baselineFindingsPerHour, candidateFindingsPerHour), formatRate(candidateFindingsPerHour)],
    ["Input tokens", formatTokens(baseline.cost?.inputTokens), compactDelta(baseline.cost?.inputTokens, candidate.cost?.inputTokens), formatTokens(candidate.cost?.inputTokens)],
    ["Output tokens", formatTokens(baseline.cost?.outputTokens), compactDelta(baseline.cost?.outputTokens, candidate.cost?.outputTokens), formatTokens(candidate.cost?.outputTokens)],
    ["High+ / USD", metric(beforeRank?.highPerDollar), decimalDelta(beforeRank?.highPerDollar, afterRank?.highPerDollar), metric(afterRank?.highPerDollar)],
    ["Findings / USD", metric(beforeRank?.totalPerDollar), decimalDelta(beforeRank?.totalPerDollar, afterRank?.totalPerDollar), metric(afterRank?.totalPerDollar)],
  ];
  return <Panel label="OPERATIONAL DELTA" title="Custo, tempo e eficiência observada">
    <div className="grid grid-cols-[minmax(5rem,1fr)_4.5rem_4.5rem_4.5rem] border-b px-4 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground sm:grid-cols-[minmax(7rem,1fr)_7rem_7rem_7rem]"><span>Métrica</span><span className="text-right">Antes</span><span className="text-right">Δ</span><span className="text-right">Depois</span></div>
    <div>{rows.map(([label, before, delta, after]) => <div key={label} className="grid min-h-12 grid-cols-[minmax(5rem,1fr)_4.5rem_4.5rem_4.5rem] items-center border-b px-4 py-2 font-mono text-[10px] tabular-nums sm:grid-cols-[minmax(7rem,1fr)_7rem_7rem_7rem]"><span className="text-muted-foreground">{label}</span><span className="text-right">{before}</span><span className="text-right text-primary">{delta}</span><span className="text-right font-semibold">{after}</span></div>)}</div>
    <div className="grid border-t sm:grid-cols-2"><ProfileCell label="PROFILE" before={`${baseline.model}/${baseline.effort}/${baseline.mode}`} after={`${candidate.model}/${candidate.effort}/${candidate.mode}`} /><ProfileCell label="REVISION" before={baseline.revision ? shortId(baseline.revision) : "unversioned"} after={candidate.revision ? shortId(candidate.revision) : "unversioned"} /></div>
  </Panel>;
}

function ProfileCell({ label, before, after }: { label: string; before: string; after: string }) {
  return <div className="min-w-0 border-b border-r p-3"><div className="bench-label">{label}</div><div className="mt-2 flex min-w-0 items-center gap-2 font-mono text-[8px]"><span className="truncate text-muted-foreground">{before}</span><HugeiconsIcon icon={ArrowRight01Icon} size={10} className="shrink-0 text-primary" /><span className="truncate">{after}</span></div></div>;
}

function FindingDiffRow({ finding }: { finding: CompareFindingDelta }) {
  const occurrence = finding.candidate ?? finding.baseline;
  if (!occurrence) return null;
  const severityChanged = finding.change === "severity_changed";
  return <details className="group border-b">
    <summary className="grid cursor-pointer list-none gap-3 px-4 py-3 hover:bg-accent/60 lg:grid-cols-[8rem_9rem_minmax(18rem,1fr)_11rem] lg:items-center">
      <span><ChangeBadge change={finding.change} /></span>
      <span className="flex items-center gap-1.5">{severityChanged && finding.baseline ? <><SeverityBadge severity={finding.baseline.severity} /><HugeiconsIcon icon={ArrowRight01Icon} size={10} className="text-muted-foreground" /></> : null}<SeverityBadge severity={occurrence.severity} /></span>
      <span className="min-w-0"><span className="block text-xs font-semibold leading-snug">{finding.title}</span><span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">{occurrence.primaryPath ?? occurrence.category ?? occurrence.ruleId ?? occurrence.findingId}</span></span>
      <span className="flex items-center gap-2 font-mono text-[8px]"><Presence active={Boolean(finding.baseline)} label="B" /><span className="h-px flex-1 bg-border" /><Presence active={Boolean(finding.candidate)} label="C" /><span className="ml-1 text-muted-foreground group-open:text-primary">＋</span></span>
    </summary>
    <div className="border-t bg-muted/10">
      <div className="grid lg:grid-cols-2">
        <OccurrenceReadout role="BASELINE" occurrence={finding.baseline} />
        <OccurrenceReadout role="CANDIDATO" occurrence={finding.candidate} />
      </div>
      <div className="border-t px-4 py-3 text-[10px] leading-5 text-muted-foreground">{occurrence.summary ?? "Este finding não trouxe resumo estruturado."}</div>
    </div>
  </details>;
}

function OccurrenceReadout({ role, occurrence }: { role: string; occurrence: CompareFindingDelta["baseline"] }) {
  return <div className="min-w-0 border-b p-4 lg:border-r">
    <div className="bench-label text-primary">{role}</div>
    {occurrence ? <>
      <div className="mt-3 flex flex-wrap items-center gap-2"><SeverityBadge severity={occurrence.severity} /><span className="font-mono text-[8px] text-muted-foreground">CONF / {occurrence.confidence ?? "—"}</span></div>
      <dl className="mt-3 grid gap-2 font-mono text-[9px]">
        <MetaLine label="PATH" value={occurrence.primaryPath ?? "—"} />
        <MetaLine label="RULE" value={occurrence.ruleId ?? "—"} />
        <MetaLine label="CATEGORY" value={occurrence.category ?? "—"} />
        <MetaLine label="CWE" value={occurrence.cwe.join(", ") || "—"} />
      </dl>
      <Button asChild variant="outline" size="sm" className="mt-4"><Link to={`/scans/${occurrence.scanId}?f=${encodeURIComponent(occurrence.findingId)}`}>Abrir evidência</Link></Button>
    </> : <div className="mt-3 border border-dashed p-4 text-xs leading-relaxed text-muted-foreground">Não reportado por este scan. Isso não comprova correção nem ausência da vulnerabilidade.</div>}
  </div>;
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>;
}

function ChangeBadge({ change }: { change: CompareFindingChange }) {
  return <span className={cx("inline-flex h-6 items-center border px-2 font-mono text-[8px] uppercase tracking-wider", changeTone[change])}>{changeLabel[change]}</span>;
}

function Presence({ active, label }: { active: boolean; label: string }) {
  return <span className={cx("flex size-5 items-center justify-center border font-mono text-[8px]", active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground/35")}>{label}</span>;
}

function decisionProfile(scan: ScanRun): string {
  const model = scan.model?.replace(/^gpt-5\.6-/, "") ?? "modelo desconhecido";
  return `${model} / ${scan.effort ?? "—"} / ${scan.mode ?? "—"}`;
}

function chartProfile(scan: ScanRun): string {
  const model = scan.model?.replace(/^gpt-5\.6-/, "") ?? "modelo";
  return `${model}/${scan.effort ?? "—"}`;
}

function decisionValue(row: ScanDecisionRow, objective: CompareObjective): string {
  if (objective === "coverage") return `${row.total} achados`;
  if (objective === "high_plus") return `${row.highPlus} High+`;
  if (objective === "cost_per_finding") return row.costPerFinding == null ? "sem custo" : `${formatUsd(row.costPerFinding)} / finding`;
  if (objective === "cost_per_high") return row.costPerHighPlus == null ? "sem High+" : `${formatUsd(row.costPerHighPlus)} / High+`;
  if (objective === "speed") return formatDuration(row.durationMs);
  return `${row.score.toFixed(0)} / 100`;
}

function decisionReason(row: ScanDecisionRow, objective: CompareObjective): string {
  const profile = decisionProfile(row.scan);
  if (objective === "coverage") return `${profile} lidera em cobertura observada com ${row.total} achados reportados. Isso mede amplitude, não confirma que todos sejam verdadeiros positivos.`;
  if (objective === "high_plus") return `${profile} reportou ${row.highPlus} sinais Critical ou High, o maior volume prioritário deste recorte.`;
  if (objective === "cost_per_finding") return `${profile} custou ${formatUsd(row.costPerFinding)} por finding reportado, o menor custo unitário do comparativo.`;
  if (objective === "cost_per_high") return `${profile} custou ${formatUsd(row.costPerHighPlus)} por sinal Critical ou High, o melhor retorno para achados prioritários.`;
  if (objective === "speed") return `${profile} terminou em ${formatDuration(row.durationMs)}, a menor duração registrada neste comparativo.`;
  return `${profile} oferece o melhor equilíbrio relativo: 30% cobertura, 25% High+, 20% custo por finding, 15% custo por High+ e 10% velocidade.`;
}

function formatChartValue(value: TooltipValueType | undefined): string {
  if (typeof value === "number") return value.toFixed(value % 1 ? 2 : 0);
  if (Array.isArray(value)) return value.join(" – ");
  return value == null ? "—" : String(value);
}

function formatRate(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(value >= 100 ? 0 : 1);
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;
}

function unitCost(cost: number | null | undefined, count: number): number | null {
  return cost == null || cost <= 0 || count <= 0 ? null : cost / count;
}

function hourlyRate(count: number, durationMs: number | null | undefined): number | null {
  return durationMs == null || durationMs <= 0 ? null : count / (durationMs / 3_600_000);
}

function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
function normalizePath(value: string | null): string { return (value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(); }
function metric(value: number | null | undefined): string { return value == null ? "—" : value.toFixed(3); }
function moneyDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${formatUsd(Math.abs(after - before))}`; }
function compactDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${formatTokens(Math.abs(after - before))}`; }
function decimalDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${Math.abs(after - before).toFixed(3)}`; }
function durationDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${formatDuration(Math.abs(after - before))}`; }
