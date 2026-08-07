import type { GateArtifact, GateRun } from "@csb/shared";
import { ChevronDown, GitCompareArrows, ShieldCheck } from "lucide-react";

import { formatUsd } from "../../format";
import { cx } from "../ui";
import { gateStageLabel } from "../../lib/guardrails";
import { GateOutcomeBadge } from "./GateOutcomeBadge";

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
  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="portfolio-pipeline-title">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <div className="bench-label text-primary">PORTFOLIO PIPELINE</div>
          <h2 id="portfolio-pipeline-title" className="mt-0.5 font-heading text-sm font-semibold">
            Mudança até decisão
          </h2>
        </div>
        <span className="font-mono text-[9px] text-muted-foreground">
          {gates.length} {gates.length === 1 ? "LANE" : "LANES"}
        </span>
      </div>

      <div className="hidden md:block">
        <div className="grid grid-cols-[minmax(9rem,1.2fr)_minmax(9rem,1.15fr)_minmax(8rem,.9fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(8rem,.85fr)] border-b bg-muted/25 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
          {[
            "Repository",
            "Changeset",
            "Scope",
            "Scan",
            "Decision",
            "PR check",
          ].map((label) => (
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
                <PipelineCell label="Repository" primary={repositoryName(gate.repositoryPath)} secondary={gate.source} icon={<ShieldCheck aria-hidden size={14} />} />
                <PipelineCell label="Changeset" primary={`${gate.baseRef} → ${gate.headRef}`} secondary={gate.id} icon={<GitCompareArrows aria-hidden size={14} />} mono />
                <PipelineCell label="Scope" primary={artifact?.changeSet.scopeMode ?? "Não determinado"} secondary={artifact ? `${artifact.changeSet.files.length} arquivo(s)` : null} />
                <PipelineCell label="Scan" primary={gateStageLabel(gate.status)} secondary={`${formatUsd(gate.estimatedUsd)} USD estimado`} />
                <div className="flex min-w-0 items-center border-r px-3 py-3">
                  <GateOutcomeBadge outcome={gate.outcome} status={gate.status} />
                </div>
                <PipelineCell
                  label="PR check"
                  primary={gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : "Não publicado"}
                  secondary={gate.source === "github" ? "GitHub" : "Local"}
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
                <ShieldCheck aria-hidden size={15} className={selected ? "text-primary" : "text-muted-foreground"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{repositoryName(gate.repositoryPath)}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                    {gate.baseRef} → {gate.headRef}
                  </span>
                </span>
                <GateOutcomeBadge outcome={gate.outcome} status={gate.status} />
                <ChevronDown aria-hidden size={14} className={cx("transition-transform motion-reduce:transition-none", selected && "rotate-180")} />
              </button>
              {selected && (
                <div className="grid grid-cols-2 border-t bg-muted/20">
                  <MobileCell label="Scope" value={artifact?.changeSet.scopeMode ?? "Não determinado"} />
                  <MobileCell label="Arquivos" value={artifact ? String(artifact.changeSet.files.length) : "Não determinado"} />
                  <MobileCell label="Scan" value={gateStageLabel(gate.status)} />
                  <MobileCell label="Custo estimado" value={`${formatUsd(gate.estimatedUsd)} USD`} />
                  <MobileCell label="PR check" value={gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : "Não publicado"} />
                  <MobileCell label="Origem" value={gate.source} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
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

function repositoryName(repositoryPath: string): string {
  return repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repositoryPath;
}
