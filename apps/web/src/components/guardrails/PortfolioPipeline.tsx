import type { GateArtifact, GateRun, GuardrailRepository } from "@csb/shared";
import {
  Activity,
  Check,
  CircleDashed,
  Cloud,
  GitBranch,
  GitCompareArrows,
  HardDrive,
  ScanSearch,
  Send,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";

import { formatUsd } from "../../format";
import { prCheckLabel } from "../../lib/github-guardrails";
import { gateStageLabel, isGateActive } from "../../lib/guardrails";
import { useI18n } from "../../i18n";
import { Badge } from "@/components/ui/badge";
import { cx } from "../ui";
import { GateOutcomeBadge } from "./GateOutcomeBadge";

type CustodyState = "complete" | "current" | "pending" | "failed";

export function PortfolioPipeline({
  repositories,
  gates,
  selectedGateId,
  selectedArtifact,
  onSelect,
}: {
  repositories: readonly GuardrailRepository[];
  gates: readonly GateRun[];
  selectedGateId: string | null;
  selectedArtifact: GateArtifact | null;
  onSelect: (gate: GateRun) => void;
}) {
  const { locale, t } = useI18n();
  const selectedGate = gates.find((gate) => gate.id === selectedGateId) ?? gates[0] ?? null;
  const projectGates = selectedGate === null
    ? []
    : gates.filter((gate) => gate.repositoryKey === selectedGate.repositoryKey);
  const projectRepositories = selectedGate === null
    ? []
    : repositories.filter((repository) => repository.repositoryKey === selectedGate.repositoryKey);
  const activeCount = projectGates.filter((gate) => isGateActive(gate.status)).length;
  const blockedCount = projectGates.filter((gate) => gate.outcome === "blocked" || gate.status === "error").length;
  const remoteCount = projectRepositories.filter((repository) => repository.source === "github").length;

  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="portfolio-pipeline-title">
      <header className="grid border-b xl:grid-cols-[minmax(0,1fr)_auto] xl:items-stretch">
        <div className="min-w-0 px-4 py-4 sm:px-5">
          <h2 id="portfolio-pipeline-title" className="font-heading text-lg font-semibold tracking-[-0.025em]">
            {t("guardrails.pipelineTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t("guardrails.pipelineSubtitle")}
          </p>
        </div>
        <dl className="grid grid-cols-3 border-t xl:min-w-[31rem] xl:border-l xl:border-t-0">
          <PortfolioReadout label={t("guardrails.portfolioRepositories")} value={projectRepositories.length} detail={`${remoteCount} ${t("guardrails.portfolioRemote")}`} />
          <PortfolioReadout label={t("guardrails.portfolioActive")} value={activeCount} tone={activeCount > 0 ? "live" : "neutral"} detail={`${projectGates.length} ${t("guardrails.portfolioRuns")}`} />
          <PortfolioReadout label={t("guardrails.portfolioBlocked")} value={blockedCount} tone={blockedCount > 0 ? "risk" : "good"} detail={blockedCount > 0 ? t("guardrails.portfolioNeedsAction") : t("guardrails.portfolioClear")} />
        </dl>
      </header>

      <div className="grid min-w-0 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="min-w-0 border-b bg-secondary/[.08] xl:border-b-0 xl:border-r" aria-label={t("guardrails.gateQueue")}>
          <div className="flex min-h-11 items-center justify-between border-b px-4 py-2.5">
            <span className="bench-label text-primary">{t("guardrails.gateQueue")}</span>
            <span className="font-mono text-[9px] tabular-nums text-muted-foreground">{projectGates.length}</span>
          </div>
          <div className="max-h-[25rem] overflow-y-auto xl:max-h-[34rem]">
            {projectGates.map((gate) => {
              const selected = gate.id === selectedGate?.id;
              return (
                <button
                  key={gate.id}
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(gate)}
                  className={cx(
                    "group grid min-h-[6.25rem] w-full grid-cols-[auto_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                    selected && "bg-primary/[.055] shadow-[inset_1px_0_0_var(--primary)]",
                  )}
                >
                  <span className={cx(
                    "mt-0.5 grid size-8 place-items-center border",
                    gate.source === "github" ? "border-info/40 text-info" : "border-primary/40 text-primary",
                    selected && "bg-background",
                  )}>
                    {gate.source === "github" ? <GitBranch aria-hidden size={14} /> : <HardDrive aria-hidden size={14} />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-start justify-between gap-2">
                      <span className="truncate text-xs font-semibold">{repositoryName(gate.repositoryPath, gate.repositoryKey)}</span>
                      <GateOutcomeBadge outcome={gate.outcome} status={gate.status} />
                    </span>
                    <span className="mt-1.5 block truncate font-mono text-[9px] text-foreground">{targetLabel(gate)}</span>
                    <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="h-4 rounded-none px-1 font-mono text-[7px] uppercase">{sourceLabel(gate)}</Badge>
                      <Badge variant="outline" className="h-4 rounded-none px-1 font-mono text-[7px] uppercase">{executorLabel(gate)}</Badge>
                      <span className="ml-auto font-mono text-[8px] tabular-nums text-muted-foreground">{formatGateDate(gate.startedAt, locale)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {selectedGate && (
          <div className="min-w-0">
            <SelectedGateHeader gate={selectedGate} artifact={selectedArtifact} />
            <CustodyRail gate={selectedGate} />
            <GateFacts gate={selectedGate} artifact={selectedArtifact} />
          </div>
        )}
      </div>
    </section>
  );
}

function PortfolioReadout({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "neutral" | "live" | "risk" | "good";
}) {
  return (
    <div className="min-w-0 border-r px-3 py-3 last:border-r-0 sm:px-4">
      <dt className="bench-label truncate">{label}</dt>
      <dd className={cx(
        "mt-1 font-mono text-xl font-semibold tabular-nums",
        tone === "live" && "text-primary",
        tone === "risk" && "text-destructive",
        tone === "good" && "text-chart-2",
      )}>{value}</dd>
      <div className="mt-0.5 truncate text-[9px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function SelectedGateHeader({ gate, artifact }: { gate: GateRun; artifact: GateArtifact | null }) {
  const { t } = useI18n();
  const v2 = artifact?.schemaVersion === 2 ? artifact : null;
  const hasObservedCost = Number.isFinite(gate.estimatedUsd) && gate.estimatedUsd > 0;
  const hasCostCeiling = Number.isFinite(gate.costCeilingUsd) && gate.costCeilingUsd > 0;
  const costLabel = hasObservedCost ? t("guardrails.selectedCost") : hasCostCeiling ? t("guardrails.costCeiling") : t("guardrails.selectedCost");
  const costValue = hasObservedCost
    ? formatUsd(gate.estimatedUsd)
    : hasCostCeiling
      ? formatUsd(gate.costCeilingUsd, true)
      : "—";
  return (
    <div className="grid min-w-0 border-b lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0 px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <GateOutcomeBadge outcome={gate.outcome} status={gate.status} />
          <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground">{gateStageLabel(gate.status)}</span>
        </div>
        <h3 className="mt-3 truncate font-heading text-xl font-semibold tracking-[-0.03em] sm:text-2xl">
          {repositoryName(gate.repositoryPath, gate.repositoryKey)}
        </h3>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5"><GitCompareArrows aria-hidden size={13} className="shrink-0 text-primary" /><span className="truncate font-mono text-[10px] text-foreground">{targetLabel(gate)}</span></span>
          <span>{sourceLabel(gate)} · {executorLabel(gate)}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 border-t lg:min-w-[22rem] lg:border-l lg:border-t-0">
        <HeaderFact label={costLabel} value={costValue} />
        <HeaderFact label={t("guardrails.selectedLineage")} value={v2?.lineage.scanLineageHash.slice(0, 12) ?? gate.scanLineageHash?.slice(0, 12) ?? t("guardrails.pending")} mono />
      </div>
    </div>
  );
}

function HeaderFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-r px-4 py-4 last:border-r-0 lg:py-5">
      <div className="bench-label">{label}</div>
      <div className={cx("mt-2 break-all text-sm font-semibold", mono && "font-mono text-[10px]")}>{value}</div>
    </div>
  );
}

function CustodyRail({ gate }: { gate: GateRun }) {
  const { t } = useI18n();
  const steps = custodySteps(gate, t);
  return (
    <div className="border-b px-4 py-5 sm:px-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="bench-label text-primary">{t("guardrails.custodyTitle")}</span>
        <span className="font-mono text-[8px] uppercase text-muted-foreground">{t("guardrails.custodyImmutable")}</span>
      </div>
      <ol className="grid grid-cols-2 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        {steps.map((step, index) => (
          <li key={step.label} className="relative min-w-0 pr-3">
            {index < steps.length - 1 && <span aria-hidden className="absolute left-6 right-0 top-3 hidden h-px bg-border lg:block" />}
            <div className="relative z-10 flex min-w-0 items-start gap-2 lg:block">
              <StepMarker state={step.state} icon={step.icon} />
              <div className="min-w-0 lg:mt-2">
                <div className="truncate font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">{step.label}</div>
                <div className={cx(
                  "mt-0.5 truncate text-[10px] font-medium",
                  step.state === "current" && "text-primary",
                  step.state === "failed" && "text-destructive",
                  step.state === "pending" && "text-muted-foreground",
                )}>{step.value}</div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepMarker({ state, icon }: { state: CustodyState; icon: React.ReactNode }) {
  return (
    <span className={cx(
      "grid size-6 shrink-0 place-items-center border bg-background",
      state === "complete" && "border-chart-2/55 text-chart-2",
      state === "current" && "border-primary bg-primary text-primary-foreground shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_22%,transparent)]",
      state === "pending" && "border-border text-muted-foreground",
      state === "failed" && "border-destructive/60 text-destructive",
    )}>{icon}</span>
  );
}

function GateFacts({ gate, artifact }: { gate: GateRun; artifact: GateArtifact | null }) {
  const { t } = useI18n();
  const v2 = artifact?.schemaVersion === 2 ? artifact : null;
  return (
    <dl className="grid min-w-0 sm:grid-cols-2 lg:grid-cols-3">
      <IdentityFact label={t("guardrails.factAuthority")} value={`${sourceLabel(gate)} · ${gate.repositoryKey}`} />
      <IdentityFact label={t("guardrails.factTargetSha")} value={gate.resolvedHeadSha ?? t("guardrails.pending")} mono />
      <IdentityFact label={t("guardrails.factPolicy")} value={`${v2?.policySource ?? "unknown"} · ${gate.policySha?.slice(0, 12) ?? t("guardrails.pending")}`} mono />
      <IdentityFact label={t("guardrails.factBaseline")} value={gate.baselineCommit?.slice(0, 12) ?? t("guardrails.noBaseline")} mono />
      <IdentityFact label={t("guardrails.factPublication")} value={gate.executor === "github-actions" ? t("guardrails.actionsOwned") : prCheckLabel(gate)} />
      <IdentityFact label={t("guardrails.factArtifact")} value={gate.artifactPath ? `V${gate.artifactSchemaVersion} · ${gate.outcome ?? gate.status}` : t("guardrails.pending")} />
    </dl>
  );
}

function IdentityFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b border-r px-4 py-3 last:border-b-0 sm:last:border-b lg:[&:nth-last-child(-n+3)]:border-b-0">
      <dt className="bench-label">{label}</dt>
      <dd className={cx("mt-1.5 break-all text-[11px] leading-5", mono && "font-mono text-[9px]")}>{value}</dd>
    </div>
  );
}

function custodySteps(gate: GateRun, t: ReturnType<typeof useI18n>["t"]) {
  const failed = gate.status === "error" || gate.status === "cancelled";
  const active = isGateActive(gate.status);
  const publicationComplete = gate.publishStatus === "published" || (gate.executor === "github-actions" && Boolean(gate.workflowRunId) && gate.status === "completed");
  const publicationFailed = gate.publishStatus === "failed";
  return [
    { label: t("guardrails.stageAuthority"), value: sourceLabel(gate), state: "complete" as CustodyState, icon: gate.source === "github" ? <GitBranch aria-hidden size={12} /> : <HardDrive aria-hidden size={12} /> },
    { label: t("guardrails.stageTarget"), value: gate.resolvedHeadSha?.slice(0, 8) ?? t("guardrails.pending"), state: gate.resolvedHeadSha ? "complete" as CustodyState : failed ? "failed" as CustodyState : "current" as CustodyState, icon: <GitCompareArrows aria-hidden size={12} /> },
    { label: t("guardrails.stagePolicy"), value: gate.policySha?.slice(0, 8) ?? t("guardrails.pending"), state: gate.policySha ? "complete" as CustodyState : failed ? "failed" as CustodyState : gate.resolvedHeadSha ? "current" as CustodyState : "pending" as CustodyState, icon: <ShieldCheck aria-hidden size={12} /> },
    { label: t("guardrails.stageScan"), value: gate.scanId ? gateStageLabel(gate.status) : t("guardrails.pending"), state: gate.scanId && !active ? "complete" as CustodyState : failed ? "failed" as CustodyState : gate.scanId || gate.status === "scanning" ? "current" as CustodyState : "pending" as CustodyState, icon: <ScanSearch aria-hidden size={12} /> },
    { label: t("guardrails.stageDecision"), value: gate.outcome ?? t("guardrails.pending"), state: gate.outcome === "blocked" || gate.outcome === "error" || failed ? "failed" as CustodyState : gate.outcome ? "complete" as CustodyState : gate.status === "evaluating" ? "current" as CustodyState : "pending" as CustodyState, icon: gate.outcome === "blocked" || failed ? <X aria-hidden size={12} /> : gate.outcome ? <Check aria-hidden size={12} /> : <Activity aria-hidden size={12} /> },
    { label: t("guardrails.stagePublication"), value: publicationComplete ? t("guardrails.published") : publicationFailed ? t("guardrails.failed") : gate.executor === "github-actions" ? "ACTIONS" : t("guardrails.pending"), state: publicationComplete ? "complete" as CustodyState : publicationFailed ? "failed" as CustodyState : gate.status === "publishing" || gate.status === "completed" ? "current" as CustodyState : "pending" as CustodyState, icon: gate.executor === "github-actions" ? <Workflow aria-hidden size={12} /> : publicationComplete ? <Send aria-hidden size={12} /> : <CircleDashed aria-hidden size={12} /> },
  ];
}

function repositoryName(repositoryPath: string | null, repositoryKey: string): string {
  if (repositoryPath === null) return repositoryKey.split("/").at(-1) ?? repositoryKey;
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

function formatGateDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}
