import type { DecisionGraphNode as DecisionNode, GateArtifact } from "@csb/shared";
import { ChevronLeft, ChevronRight, FileCode2, GitBranch, Search, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { SeverityBadge, cx } from "../ui";
import { guardrailFindingBranches } from "../../lib/guardrails";
import { useI18n } from "../../i18n";

const FULL_GRAPH_FINDING_LIMIT = 24;
const FILES_PER_PAGE = 12;
const FINDINGS_PER_PAGE = 20;

type FindingBranch = ReturnType<typeof guardrailFindingBranches>[number];

export function DecisionGraph({
  artifact,
  selectedNodeId,
  onSelect,
}: {
  artifact: GateArtifact;
  selectedNodeId: string | null;
  onSelect: (node: DecisionNode) => void;
}) {
  const branches = guardrailFindingBranches(artifact);
  const findings = branches.flatMap((branch) => branch.findings);

  if (findings.length > FULL_GRAPH_FINDING_LIMIT) {
    return (
      <ScalableFindingExplorer
        artifact={artifact}
        branches={branches}
        selectedNodeId={selectedNodeId}
        onSelect={onSelect}
      />
    );
  }

  return <CompactFindingGraph artifact={artifact} branches={branches} selectedNodeId={selectedNodeId} onSelect={onSelect} />;
}

function GraphHeader({ artifact, scalable }: { artifact: GateArtifact; scalable: boolean }) {
  const { t } = useI18n();
  const fileCount = guardrailFindingBranches(artifact).length;
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="bench-label text-primary">DECISION GRAPH / FINDING MAP</div>
        <h2 id="decision-graph-title" className="mt-1 font-heading text-base font-semibold">{t("guardrails.graphTitle")}</h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
          {scalable
            ? t("guardrails.graphScaleDescription")
            : t("guardrails.graphDescription")}
        </p>
      </div>
      <div className="flex shrink-0 border">
        <GraphMetric label={t("guardrails.graphFiles")} value={fileCount} />
        <GraphMetric label={t("guardrails.findings")} value={artifact.findings.length} />
      </div>
    </div>
  );
}

function GraphMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-20 border-r px-3 py-2 last:border-r-0">
      <div className="bench-label">{label}</div>
      <div className="mt-1 font-mono text-base text-primary">{value}</div>
    </div>
  );
}

function CompactFindingGraph({
  artifact,
  branches,
  selectedNodeId,
  onSelect,
}: {
  artifact: GateArtifact;
  branches: FindingBranch[];
  selectedNodeId: string | null;
  onSelect: (node: DecisionNode) => void;
}) {
  const { t } = useI18n();
  const findings = branches.flatMap((branch) => branch.findings);
  const rowHeight = 76;
  const graphHeight = Math.max(findings.length * rowHeight, 228);
  let rowCursor = 0;

  return (
    <section className="bench-panel min-w-0" aria-labelledby="decision-graph-title">
      <GraphHeader artifact={artifact} scalable={false} />
      <div className="p-3 md:p-4">
        <div className="hidden overflow-auto border bg-background/45 lg:block">
          <div className="relative min-w-[940px]" style={{ height: graphHeight }}>
            <svg className="pointer-events-none absolute inset-0 size-full text-border" viewBox={`0 0 1000 ${graphHeight}`} preserveAspectRatio="none" aria-hidden>
              {branches.map((branch) => {
                const start = rowCursor;
                rowCursor += branch.findings.length;
                const fileY = (start + branch.findings.length / 2) * rowHeight;
                return (
                  <g key={branch.path} fill="none" stroke="currentColor" strokeWidth="1">
                    <path d={`M 195 ${graphHeight / 2} C 245 ${graphHeight / 2}, 245 ${fileY}, 302 ${fileY}`} />
                    {branch.findings.map((_, index) => {
                      const findingY = (start + index + 0.5) * rowHeight;
                      return <path key={index} d={`M 522 ${fileY} C 570 ${fileY}, 570 ${findingY}, 620 ${findingY}`} />;
                    })}
                  </g>
                );
              })}
            </svg>

            <div className="absolute left-[2%] top-1/2 w-[18%] -translate-y-1/2 border border-primary/45 bg-card/95 shadow-[0_0_40px_rgba(0,229,229,.06)]">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="bench-label text-primary">GATE ROOT</span>
                <GitBranch aria-hidden size={14} className="text-primary" />
              </div>
              <div className="p-3">
                <p className="text-sm font-semibold">{artifact.repository.key}</p>
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[.1em] text-muted-foreground">
                  {artifact.changeSet.files.length} {t("guardrails.graphFiles")}
                </p>
                <div className="mt-3 flex items-center justify-between border-t pt-3">
                  <span className="bench-label">{t("guardrails.findings")}</span>
                  <strong className="font-mono text-xl text-primary">{artifact.findings.length}</strong>
                </div>
              </div>
            </div>

            {(() => {
              let start = 0;
              return branches.map((branch) => {
                const top = (start + branch.findings.length / 2) * rowHeight;
                start += branch.findings.length;
                const shortPath = branch.path.split("/").pop() || branch.path;
                return (
                  <div key={branch.path} className="absolute left-[30%] w-[23%] -translate-y-1/2 border bg-card/95" style={{ top }}>
                    <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
                      <FileCode2 aria-hidden size={14} className="shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold" title={branch.path}>{shortPath}</span>
                        <span className="block truncate font-mono text-[8px] text-muted-foreground" title={branch.path}>{branch.path}</span>
                      </span>
                      <span className="font-mono text-xs text-primary">{branch.findings.length}</span>
                    </div>
                  </div>
                );
              });
            })()}

            {findings.map((item, index) => {
              const selected = item.node.id === selectedNodeId;
              return (
                <button
                  key={item.node.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(item.node)}
                  className={cx(
                    "absolute left-[62%] flex w-[36%] -translate-y-1/2 items-center gap-3 border bg-card/95 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    selected && "border-primary bg-primary/[.07] shadow-[inset_3px_0_0_var(--primary)]",
                  )}
                  style={{ top: (index + 0.5) * rowHeight }}
                >
                  <ShieldAlert aria-hidden size={15} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-xs font-semibold leading-5">{item.finding.title}</span>
                    <span className="mt-0.5 block truncate font-mono text-[8px] uppercase tracking-[.08em] text-muted-foreground">
                      {item.finding.lifecycle} · {item.finding.ruleId ?? item.finding.category ?? "security finding"}
                    </span>
                  </span>
                  <SeverityBadge severity={item.finding.severity} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 lg:hidden">
          {branches.map((branch) => (
            <section key={branch.path} className="border bg-card/70">
              <div className="flex items-center gap-2 border-b px-3 py-2.5">
                <FileCode2 aria-hidden size={14} className="shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate font-mono text-[9px]" title={branch.path}>{branch.path}</span>
                <span className="font-mono text-xs text-primary">{branch.findings.length}</span>
              </div>
              <div className="grid gap-px bg-border">
                {branch.findings.map((item) => (
                  <button key={item.node.id} type="button" onClick={() => onSelect(item.node)} className={cx("flex min-w-0 items-start gap-3 bg-background px-3 py-3 text-left", item.node.id === selectedNodeId && "bg-primary/[.07] shadow-[inset_3px_0_0_var(--primary)]")}>
                    <span className="min-w-0 flex-1 text-xs font-semibold leading-5">{item.finding.title}</span>
                    <SeverityBadge severity={item.finding.severity} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScalableFindingExplorer({
  artifact,
  branches,
  selectedNodeId,
  onSelect,
}: {
  artifact: GateArtifact;
  branches: FindingBranch[];
  selectedNodeId: string | null;
  onSelect: (node: DecisionNode) => void;
}) {
  const { t } = useI18n();
  const selectedPath = branches.find((branch) => branch.findings.some((item) => item.node.id === selectedNodeId))?.path;
  const [activePath, setActivePath] = useState(selectedPath ?? branches[0]?.path ?? "");
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("all");
  const [filePage, setFilePage] = useState(0);
  const [findingPage, setFindingPage] = useState(0);

  const filteredBranches = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return branches.flatMap((branch) => {
      const branchMatches = branch.path.toLocaleLowerCase().includes(normalizedQuery);
      const filteredFindings = branch.findings.filter((item) => {
        const matchesSeverity = severity === "all" || item.finding.severity === severity;
        const matchesQuery = !normalizedQuery || branchMatches || item.finding.title.toLocaleLowerCase().includes(normalizedQuery);
        return matchesSeverity && matchesQuery;
      });
      return filteredFindings.length ? [{ ...branch, findings: filteredFindings }] : [];
    });
  }, [branches, query, severity]);

  useEffect(() => {
    setFilePage(0);
    setFindingPage(0);
    if (!filteredBranches.some((branch) => branch.path === activePath)) {
      setActivePath(filteredBranches[0]?.path ?? "");
    }
  }, [query, severity]);

  useEffect(() => {
    if (!selectedPath) return;
    const selectedIndex = filteredBranches.findIndex((branch) => branch.path === selectedPath);
    if (selectedIndex < 0) return;
    setActivePath(selectedPath);
    setFilePage(Math.floor(selectedIndex / FILES_PER_PAGE));
    const selectedFindingIndex = filteredBranches[selectedIndex]?.findings.findIndex((item) => item.node.id === selectedNodeId) ?? -1;
    if (selectedFindingIndex >= 0) setFindingPage(Math.floor(selectedFindingIndex / FINDINGS_PER_PAGE));
  }, [filteredBranches, selectedNodeId, selectedPath]);

  const activeBranch = filteredBranches.find((branch) => branch.path === activePath) ?? filteredBranches[0] ?? null;
  const filePageCount = Math.max(1, Math.ceil(filteredBranches.length / FILES_PER_PAGE));
  const visibleBranches = filteredBranches.slice(filePage * FILES_PER_PAGE, (filePage + 1) * FILES_PER_PAGE);
  const findingPageCount = Math.max(1, Math.ceil((activeBranch?.findings.length ?? 0) / FINDINGS_PER_PAGE));
  const visibleFindings = activeBranch?.findings.slice(findingPage * FINDINGS_PER_PAGE, (findingPage + 1) * FINDINGS_PER_PAGE) ?? [];

  function activateBranch(path: string) {
    setActivePath(path);
    setFindingPage(0);
  }

  function changeFilePage(nextPage: number) {
    setFilePage(nextPage);
    setFindingPage(0);
    const nextBranch = filteredBranches[nextPage * FILES_PER_PAGE];
    if (nextBranch) setActivePath(nextBranch.path);
  }

  return (
    <section className="bench-panel min-w-0" aria-labelledby="decision-graph-title">
      <GraphHeader artifact={artifact} scalable />
      <div className="grid border-b lg:grid-cols-[minmax(15rem,.72fr)_minmax(20rem,1.28fr)]">
        <label className="flex min-w-0 items-center gap-2 border-b px-3 py-3 lg:border-b-0 lg:border-r">
          <Search aria-hidden size={14} className="shrink-0 text-muted-foreground" />
          <span className="sr-only">{t("guardrails.graphSearch")}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("guardrails.graphSearch")}
            className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-3" aria-label={t("guardrails.graphFilterSeverity")}>
          {["all", "critical", "high", "medium", "low", "info"].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={severity === value}
              onClick={() => setSeverity(value)}
              className={cx(
                "h-8 shrink-0 border px-3 font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground",
                severity === value && "border-primary bg-primary/[.08] text-primary",
              )}
            >
              {value === "all" ? t("common.all") : value}
            </button>
          ))}
          <span className="basis-full font-mono text-[9px] text-muted-foreground sm:ml-auto sm:basis-auto">
            {t("guardrails.graphMatches").replace("{count}", String(filteredBranches.reduce((total, branch) => total + branch.findings.length, 0)))}
          </span>
        </div>
      </div>

      {activeBranch ? (
        <div className="grid min-h-[34rem] lg:grid-cols-[14rem_minmax(16rem,.82fr)_minmax(22rem,1.45fr)]">
          <div className="hidden border-r p-3 lg:flex lg:flex-col lg:justify-center">
            <div className="border border-primary/45 bg-card/95">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="bench-label text-primary">GATE ROOT</span>
                <GitBranch aria-hidden size={14} className="text-primary" />
              </div>
              <div className="p-3">
                <p className="truncate text-xs font-semibold" title={artifact.repository.key}>{artifact.repository.key}</p>
                <p className="mt-2 font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">{artifact.changeSet.files.length} {t("guardrails.graphFiles")}</p>
                <div className="mt-3 flex items-center justify-between border-t pt-3">
                  <span className="bench-label">{t("guardrails.findings")}</span>
                  <strong className="font-mono text-xl text-primary">{artifact.findings.length}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-col border-b lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="bench-label">{t("guardrails.graphBranches")}</span>
              <span className="font-mono text-[9px] text-muted-foreground">{filteredBranches.length}</span>
            </div>
            <div className="grid flex-1 content-start gap-px bg-border">
              {visibleBranches.map((branch) => {
                const active = branch.path === activeBranch.path;
                const shortPath = branch.path.split("/").pop() || branch.path;
                return (
                  <button
                    key={branch.path}
                    type="button"
                    aria-pressed={active}
                    onClick={() => activateBranch(branch.path)}
                    className={cx("flex min-w-0 items-center gap-2 bg-background px-3 py-3 text-left hover:bg-accent", active && "bg-primary/[.07] shadow-[inset_3px_0_0_var(--primary)]")}
                  >
                    <FileCode2 aria-hidden size={14} className="shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold" title={branch.path}>{shortPath}</span>
                      <span className="block truncate font-mono text-[8px] text-muted-foreground" title={branch.path}>{branch.path}</span>
                    </span>
                    <span className="font-mono text-xs text-primary">{branch.findings.length}</span>
                  </button>
                );
              })}
            </div>
            <Pagination page={filePage} pageCount={filePageCount} label={t("guardrails.graphFiles")} onChange={changeFilePage} />
          </div>

          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center justify-between gap-3 border-b px-3 py-2">
              <div className="min-w-0">
                <span className="bench-label text-primary">{t("guardrails.graphSelectedBranch")}</span>
                <p className="mt-1 truncate font-mono text-[9px]" title={activeBranch.path}>{activeBranch.path}</p>
              </div>
              <span className="shrink-0 font-mono text-xs text-primary">{activeBranch.findings.length} findings</span>
            </div>
            <div className="grid flex-1 content-start gap-px bg-border">
              {visibleFindings.map((item) => (
                <button
                  key={item.node.id}
                  type="button"
                  aria-pressed={item.node.id === selectedNodeId}
                  onClick={() => onSelect(item.node)}
                  className={cx("flex min-w-0 items-center gap-3 bg-background px-3 py-3 text-left hover:bg-accent", item.node.id === selectedNodeId && "bg-primary/[.07] shadow-[inset_3px_0_0_var(--primary)]")}
                >
                  <ShieldAlert aria-hidden size={15} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-xs font-semibold leading-5">{item.finding.title}</span>
                    <span className="mt-0.5 block truncate font-mono text-[8px] uppercase tracking-[.08em] text-muted-foreground">{item.finding.lifecycle} · {item.finding.ruleId ?? item.finding.category ?? "security finding"}</span>
                  </span>
                  <SeverityBadge severity={item.finding.severity} />
                </button>
              ))}
            </div>
            <Pagination page={findingPage} pageCount={findingPageCount} label="findings" onChange={setFindingPage} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("guardrails.graphEmpty")}
        </div>
      )}
    </section>
  );
}

function Pagination({ page, pageCount, label, onChange }: { page: number; pageCount: number; label: string; onChange: (page: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-11 items-center justify-between border-t px-3 py-2">
      <button type="button" aria-label={t("guardrails.graphPrevious").replace("{label}", label)} disabled={page === 0} onClick={() => onChange(page - 1)} className="flex size-8 items-center justify-center border text-muted-foreground disabled:opacity-30">
        <ChevronLeft aria-hidden size={14} />
      </button>
      <span className="font-mono text-[9px] text-muted-foreground">{page + 1} / {pageCount}</span>
      <button type="button" aria-label={t("guardrails.graphNext").replace("{label}", label)} disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)} className="flex size-8 items-center justify-center border text-muted-foreground disabled:opacity-30">
        <ChevronRight aria-hidden size={14} />
      </button>
    </div>
  );
}
