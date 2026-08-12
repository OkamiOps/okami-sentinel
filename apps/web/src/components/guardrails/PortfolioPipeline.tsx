import type { GateArtifact, GateRun } from "@csb/shared";
import { ChevronDown, Cloud, GitBranch, GitCompareArrows, HardDrive, ShieldCheck, Workflow } from "lucide-react";

import { formatUsd } from "../../format";
import { cx } from "../ui";
import { prCheckLabel } from "../../lib/github-guardrails";
import { gateStageLabel } from "../../lib/guardrails";
import { GateOutcomeBadge } from "./GateOutcomeBadge";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "../../i18n";

export function PortfolioPipeline({
  gates,
  selectedGateId,
  selectedArtifact,
  onSelect,
}: {
  gates: readonly GateRun[];
  selectedGateId: string | null;
  selectedArtifact: GateArtifact | null;
  onSelect: (gate: GateRun) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="portfolio-pipeline-title">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <div className="bench-label text-primary">{t("guardrails.pipelineTitle")}</div>
          <h2 id="portfolio-pipeline-title" className="mt-0.5 font-heading text-sm font-semibold">
            {t("guardrails.pipelineSubtitle")}
          </h2>
        </div>
        <span className="font-mono text-[9px] text-muted-foreground">
          {gates.length} {gates.length === 1 ? "LANE" : "LANES"}
        </span>
      </div>

      <div className="hidden md:block">
        <div className="grid grid-cols-[minmax(9rem,1.2fr)_minmax(9rem,1.15fr)_minmax(8rem,.9fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(8rem,.85fr)] border-b bg-muted/25 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
          {["Authority", "Target", "Policy", "Scan", "Decision", "Publication"].map((label) => (
            <span key={label} className="border-r px-3 py-2.5 last:border-r-0">
              {label}
            </span>
          ))}
        </div>
        <div>
          {gates.map((gate) => {
            const selected = gate.id === selectedGateId;
            const artifact = selected ? selectedArtifact : null;
            return (
              <button
                key={gate.id}
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(gate)}
                className={cx(
                  "grid min-h-16 w-full grid-cols-[minmax(9rem,1.2fr)_minmax(9rem,1.15fr)_minmax(8rem,.9fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(8rem,.85fr)] text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  selected && "bg-primary/[.065] shadow-[inset_3px_0_0_var(--primary)]",
                )}
              >
                <AuthorityCell gate={gate} />
                <PipelineCell label="Target" primary={targetLabel(gate)} secondary={gate.resolvedHeadSha ? `HEAD ${gate.resolvedHeadSha.slice(0, 12)}` : gate.id} icon={<GitCompareArrows aria-hidden size={14} />} mono />
                <PipelineCell label="Policy" primary={gate.policySha ? gate.policySha.slice(0, 12) : "Pendente"} secondary={artifact && artifact.schemaVersion === 2 ? artifact.policySource : `POLICY V${gate.policyVersion}`} mono />
                <PipelineCell label="Scan" primary={gateStageLabel(gate.status)} secondary={artifact && artifact.schemaVersion === 2 ? `${artifact.lineage.model} · ${artifact.lineage.reasoningEffort}` : `${formatUsd(gate.estimatedUsd)} USD estimado`} />
                <div className="flex min-w-0 items-center border-r px-3 py-3">
                  <div className="min-w-0"><GateOutcomeBadge outcome={gate.outcome} status={gate.status} /><span className="mt-1 block truncate font-mono text-[8px] uppercase text-muted-foreground">{gate.baselineCommit ? `BASE ${gate.baselineCommit.slice(0, 10)}` : "SEM BASELINE"}</span></div>
                </div>
                <PipelineCell
                  label="Publication"
                  primary={gate.executor === "github-actions" ? "Actions owned" : prCheckLabel(gate)}
                  secondary={gate.workflowRunId ? `RUN ${gate.workflowRunId}` : gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : gate.source === "github" ? "GITHUB" : "LOCAL"}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="md:hidden">
        {gates.map((gate) => {
          const selected = gate.id === selectedGateId;
          const artifact = selected ? selectedArtifact : null;
          return (
            <div key={gate.id} className="border-b last:border-b-0">
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                aria-expanded={selected}
                onClick={() => onSelect(gate)}
                className={cx(
                  "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  selected && "bg-primary/[.065] shadow-[inset_3px_0_0_var(--primary)]",
                )}
              >
                {gate.source === "github" ? <GitBranch aria-hidden size={15} className={selected ? "text-info" : "text-muted-foreground"} /> : <HardDrive aria-hidden size={15} className={selected ? "text-primary" : "text-muted-foreground"} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{repositoryName(gate.repositoryPath, gate.repositoryKey)}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                    {sourceLabel(gate)} · {executorLabel(gate)} · {targetLabel(gate)}
                  </span>
                </span>
                <GateOutcomeBadge outcome={gate.outcome} status={gate.status} />
                <ChevronDown aria-hidden size={14} className={cx("transition-transform motion-reduce:transition-none", selected && "rotate-180")} />
              </button>
              {selected && (
                <div className="grid grid-cols-2 border-t bg-muted/20">
                  <MobileCell label="Policy SHA" value={gate.policySha ?? "Pendente"} />
                  <MobileCell label="Executor" value={executorLabel(gate)} />
                  <MobileCell label="Scan" value={gateStageLabel(gate.status)} />
                  <MobileCell label="Custo estimado" value={`${formatUsd(gate.estimatedUsd)} USD`} />
                  <MobileCell label="Baseline" value={gate.baselineCommit ?? "Ausente"} />
                  <MobileCell label="Publicação" value={gate.executor === "github-actions" ? "GitHub Actions" : prCheckLabel(gate)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {selectedGateId && (() => {
        const gate = gates.find((item) => item.id === selectedGateId);
        return gate ? <GateIdentityStrip gate={gate} artifact={selectedArtifact} /> : null;
      })()}
    </section>
  );
}

function AuthorityCell({ gate }: { gate: GateRun }) {
  return (
    <span className="flex min-w-0 items-center gap-2 border-r px-3 py-3">
      <span className={cx("grid size-7 shrink-0 place-items-center border", gate.source === "github" ? "border-info/40 text-info" : "border-primary/40 text-primary")}>
        {gate.source === "github" ? <GitBranch aria-hidden size={13} /> : <HardDrive aria-hidden size={13} />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{repositoryName(gate.repositoryPath, gate.repositoryKey)}</span>
        <span className="mt-1 flex min-w-0 flex-wrap gap-1">
          <Badge variant="outline" className="h-4 rounded-none px-1 font-mono text-[7px] uppercase">{sourceLabel(gate)}</Badge>
          <Badge variant="outline" className="h-4 rounded-none px-1 font-mono text-[7px] uppercase">{executorLabel(gate)}</Badge>
        </span>
      </span>
    </span>
  );
}

function GateIdentityStrip({ gate, artifact }: { gate: GateRun; artifact: GateArtifact | null }) {
  const v2 = artifact?.schemaVersion === 2 ? artifact : null;
  return (
    <div className="grid border-t bg-secondary/15 sm:grid-cols-2 xl:grid-cols-6" aria-label="Identidade congelada do gate selecionado">
      <IdentityFact icon={gate.source === "github" ? <GitBranch aria-hidden size={13} /> : <HardDrive aria-hidden size={13} />} label="Authority" value={`${sourceLabel(gate)} · ${repositoryName(gate.repositoryPath, gate.repositoryKey)}`} />
      <IdentityFact icon={gate.executor === "github-actions" ? <Workflow aria-hidden size={13} /> : <Cloud aria-hidden size={13} />} label="Execution" value={executorLabel(gate)} />
      <IdentityFact icon={<GitCompareArrows aria-hidden size={13} />} label="Target" value={targetLabel(gate)} />
      <IdentityFact icon={<ShieldCheck aria-hidden size={13} />} label="Policy" value={`${v2?.policySource ?? "unknown"} · ${gate.policySha?.slice(0, 12) ?? "pending"}`} />
      <IdentityFact icon={<ShieldCheck aria-hidden size={13} />} label="Lineage" value={v2?.lineage.scanLineageHash.slice(0, 12) ?? gate.scanLineageHash?.slice(0, 12) ?? "pending"} />
      <IdentityFact icon={<ShieldCheck aria-hidden size={13} />} label="Publication owner" value={gate.executor === "github-actions" ? "GitHub Actions" : "Sentinel managed"} />
    </div>
  );
}

function IdentityFact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="min-w-0 border-b border-r px-3 py-3 xl:border-b-0"><div className="flex items-center gap-1.5 text-primary">{icon}<span className="bench-label">{label}</span></div><div className="mt-1 break-all font-mono text-[9px] text-foreground">{value}</div></div>;
}

function PipelineCell({
  label,
  primary,
  secondary,
  icon,
  mono,
}: {
  label: string;
  primary: string;
  secondary: string | null;
  icon?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 border-r px-3 py-3">
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="min-w-0">
        <span className="sr-only">{label}: </span>
        <span className={cx("block truncate text-xs font-medium", mono && "font-mono text-[10px]")}>{primary}</span>
        {secondary && <span className="mt-1 block truncate font-mono text-[8px] uppercase text-muted-foreground">{secondary}</span>}
      </span>
    </span>
  );
}

function MobileCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-r px-3 py-3">
      <div className="bench-label">{label}</div>
      <div className="mt-1 break-words text-xs">{value}</div>
    </div>
  );
}

function repositoryName(repositoryPath: string | null, repositoryKey: string): string {
  if (repositoryPath === null) return repositoryKey;
  return repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repositoryKey;
}

function sourceLabel(gate: GateRun): string {
  return gate.source === "github" ? "GITHUB" : "LOCAL";
}

function executorLabel(gate: GateRun): string {
  return gate.executor === "github-actions" ? "ACTIONS" : "MANAGED";
}

function targetLabel(gate: GateRun): string {
  return gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : `${gate.baseRef} → ${gate.headRef}`;
}
