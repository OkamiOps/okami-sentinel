import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  ArrowRight01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
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
      description="Escolha um baseline e até quatro candidatos. A matriz compara todos os scans; o ledger detalha cada candidato contra o mesmo baseline."
      actions={<Button onClick={() => void compare()} disabled={busy || selected.length < 2}>
        <HugeiconsIcon icon={Analytics01Icon} size={13} />
        {busy ? "CALCULANDO DIFF…" : `COMPARAR ${selected.length} SCANS`}
      </Button>}
    />
    {error && <AlertBanner>{error}</AlertBanner>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel className={cx("order-2 xl:order-1", result && "hidden xl:block")} label="RUN LIBRARY" title={`${scans.length} scans concluídos`} aside={<span className="font-mono text-[8px] text-muted-foreground">SELECIONE 2–5</span>}>
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
    </div>
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
  const [change, setChange] = useState<CompareFindingChange | "all">("all");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [query, setQuery] = useState("");
  useEffect(() => {
    setActiveCandidateId(result.candidateScanIds[0] ?? "");
    setChange("all");
    setSeverity("all");
    setQuery("");
  }, [result]);
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

    <ScanSeverityMatrix scans={result.scans} baselineScanId={result.baselineScanId} activeCandidateId={activeCandidateId} onSelect={selectCandidate} />
    <DetectionScoreboard scans={result.scans} baselineScanId={result.baselineScanId} activeCandidateId={activeCandidateId} />

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
  return <Panel className="mb-4" label="CANDIDATE CHANNELS" title="Escolha o diff detalhado" aside={<span className="font-mono text-[8px] text-muted-foreground">TODOS PERMANECEM NA MATRIZ</span>} wrapTitle>
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

function ScanSeverityMatrix({ scans, baselineScanId, activeCandidateId, onSelect }: { scans: ScanRun[]; baselineScanId: string; activeCandidateId: string; onSelect: (id: string) => void }) {
  return <Panel className="mt-4" label="MULTI-SCAN MATRIX" title="Achados reportados por severidade" aside={<span className="font-mono text-[8px] text-muted-foreground">CLIQUE EM UM CANDIDATO PARA ABRIR O DIFF</span>} wrapTitle>
    <div className="overflow-x-auto">
      <table className="table min-w-[48rem]">
        <thead><tr className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><th>Severidade</th>{scans.map((scan, index) => <th key={scan.id} className={cx("min-w-36", scan.id === activeCandidateId && "bg-accent")}><button type="button" disabled={scan.id === baselineScanId} onClick={() => onSelect(scan.id)} className="w-full text-left disabled:cursor-default"><span className="block text-primary">{scan.id === baselineScanId ? "Baseline" : `C-${String(index).padStart(2, "0")}`}</span><span className="mt-1 block truncate text-[10px] normal-case text-foreground">{scan.displayName}</span><span className="mt-0.5 block truncate text-[7px] font-normal normal-case text-muted-foreground">{scan.model}/{scan.effort}</span></button></th>)}</tr></thead>
        <tbody>{severityRows.map(([key, label]) => <tr key={key}><td className={cx("font-mono text-[9px] uppercase", key === "critical" && "text-destructive", key === "high" && "text-destructive/80", key === "medium" && "text-chart-3", key === "low" && "text-chart-5", key === "total" && "font-semibold text-foreground")}>{label}</td>{scans.map((scan) => <td key={scan.id} className={cx("font-mono text-sm font-semibold tabular-nums", scan.id === activeCandidateId && "bg-accent text-primary")}>{scan.severity[key]}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </Panel>;
}

function DetectionScoreboard({ scans, baselineScanId, activeCandidateId }: { scans: ScanRun[]; baselineScanId: string; activeCandidateId: string }) {
  const ordered = [...scans].sort((left, right) => right.severity.total - left.severity.total);
  const largestCount = Math.max(...scans.map((scan) => scan.severity.total));
  const positiveCosts = scans.map((scan) => scan.cost?.estimatedUsd).filter((value): value is number => value != null && value > 0);
  const lowestCost = positiveCosts.length ? Math.min(...positiveCosts) : null;
  return <Panel className="mt-4" label="DETECTION SCOREBOARD" title="Quem reportou mais, quanto custou e quanto demorou" aside={<span className="font-mono text-[8px] text-muted-foreground">VOLUME ≠ PRECISÃO · ORDENADO POR TOTAL</span>} wrapTitle>
    <div className="overflow-x-auto">
      <table className="table min-w-[66rem]">
        <thead><tr className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><th>Execução</th><th>Perfil</th><th>Critical</th><th>High+</th><th>Total</th><th>Custo</th><th>USD / finding</th><th>Duração</th><th>Input</th><th>Output</th></tr></thead>
        <tbody>{ordered.map((scan) => {
          const cost = scan.cost?.estimatedUsd;
          const costPerFinding = cost != null && scan.severity.total > 0 ? cost / scan.severity.total : null;
          return <tr key={scan.id} className={cx(scan.id === activeCandidateId && "bg-accent")}>
            <td><div className="flex items-center gap-2"><span className="text-xs font-semibold">{scan.displayName}</span>{scan.severity.total === largestCount && <span className="border border-primary/40 px-1.5 py-0.5 font-mono text-[7px] uppercase text-primary">maior contagem</span>}</div><div className="mt-1 font-mono text-[8px] text-muted-foreground">{scan.id === baselineScanId ? "BASELINE" : scan.id === activeCandidateId ? "CANDIDATO ATIVO" : shortId(scan.id)}</div></td>
            <td className="font-mono text-[8px] text-muted-foreground">{scan.model}/{scan.effort}/{scan.mode}</td>
            <td className="font-mono text-destructive">{scan.severity.critical}</td>
            <td className="font-mono text-destructive">{scan.severity.critical + scan.severity.high}</td>
            <td className="font-mono text-sm font-semibold">{scan.severity.total}</td>
            <td className="font-mono text-primary">{formatUsd(cost)}{cost != null && cost === lowestCost && <span className="ml-2 text-[7px] uppercase text-chart-2">menor</span>}</td>
            <td className="font-mono">{costPerFinding == null ? "—" : formatUsd(costPerFinding)}</td>
            <td className="font-mono">{formatDuration(scan.durationMs)}</td>
            <td className="font-mono">{formatTokens(scan.cost?.inputTokens)}</td>
            <td className="font-mono">{formatTokens(scan.cost?.outputTokens)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="border-t px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">“Maior contagem” indica apenas volume reportado. Para medir qualidade do scanner ainda é necessário confirmar findings, falsos positivos e duplicidades.</div>
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
  const rows: Array<[string, ReactNode, ReactNode, ReactNode]> = [
    ["Custo estimado", formatUsd(baseline.cost?.estimatedUsd), moneyDelta(baseline.cost?.estimatedUsd, candidate.cost?.estimatedUsd), formatUsd(candidate.cost?.estimatedUsd)],
    ["Duração", <LiveDuration startedAt={baseline.startedAt} completedAt={baseline.completedAt} status={baseline.status} durationMs={baseline.durationMs} showDot={false} />, durationDelta(baseline.durationMs, candidate.durationMs), <LiveDuration startedAt={candidate.startedAt} completedAt={candidate.completedAt} status={candidate.status} durationMs={candidate.durationMs} showDot={false} />],
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

function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
function normalizePath(value: string | null): string { return (value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(); }
function metric(value: number | null | undefined): string { return value == null ? "—" : value.toFixed(3); }
function moneyDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${formatUsd(Math.abs(after - before))}`; }
function compactDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${formatTokens(Math.abs(after - before))}`; }
function decimalDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${Math.abs(after - before).toFixed(3)}`; }
function durationDelta(before: number | null | undefined, after: number | null | undefined): string { return before == null || after == null ? "—" : `${after - before >= 0 ? "+" : "−"}${formatDuration(Math.abs(after - before))}`; }
