import type { DecisionGraphNode as DecisionNode, GateArtifact, Severity } from "@csb/shared";
import { Check, ChevronRight, CircleAlert, CircleDot, FileCode2, GitBranch, ShieldCheck, X } from "lucide-react";

import { cx } from "../ui";
import { buildFindingTree } from "../../lib/guardrails";
import { useI18n } from "../../i18n";

const toneClasses: Record<DecisionNode["tone"], string> = {
  neutral: "border-border text-muted-foreground",
  good: "border-chart-2/55 text-chart-2",
  warning: "border-chart-3/55 text-chart-3",
  risk: "border-destructive/60 text-destructive",
};

function ToneIcon({ tone }: { tone: DecisionNode["tone"] }) {
  if (tone === "good") return <Check aria-hidden size={14} />;
  if (tone === "warning") return <CircleAlert aria-hidden size={14} />;
  if (tone === "risk") return <X aria-hidden size={14} />;
  return <CircleDot aria-hidden size={14} />;
}

export function DecisionGraph({
  artifact,
  selectedNodeId,
  onSelect,
}: {
  artifact: GateArtifact;
  selectedNodeId: string | null;
  onSelect: (node: DecisionNode) => void;
}) {
  const { t } = useI18n();
  const tree = buildFindingTree(artifact);
  const verdictTone = artifact.decision.outcome === "blocked" || artifact.decision.outcome === "error"
    ? "risk"
    : artifact.decision.outcome === "warning" || artifact.decision.outcome === "bootstrap"
      ? "warning"
      : "good";

  return (
    <section className="bench-panel min-w-0" aria-labelledby="decision-graph-title">
      <div className="flex flex-col gap-4 border-b px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="bench-label text-primary">{t("guardrails.findingTreeEyebrow")}</div>
          <h2 id="decision-graph-title" className="mt-1 font-heading text-base font-semibold">
            {t("guardrails.findingTreeTitle")}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            {t("guardrails.findingTreeDescription")}
          </p>
        </div>
        <div className="grid grid-cols-3 border-l border-t sm:min-w-[24rem]">
          <TreeMetric label={t("guardrails.files")} value={tree.files.length} />
          <TreeMetric label={t("guardrails.findings")} value={tree.findingCount} />
          <TreeMetric label="HIGH+" value={tree.highPlusCount} tone="risk" />
        </div>
      </div>
      <div className="grid min-w-0 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="relative min-w-0 border-b bg-secondary/[.08] p-4 lg:border-b-0 lg:border-r">
          <div className={cx("relative z-10 border bg-background p-4", toneClasses[verdictTone])}>
            <div className="flex items-center justify-between gap-3">
              <span className={cx("grid size-9 place-items-center border", toneClasses[verdictTone])}>
                <ShieldCheck aria-hidden size={16} />
              </span>
              <span className="bench-label">{t("guardrails.verdict")}</span>
            </div>
            <strong className="mt-4 block font-heading text-xl uppercase">{artifact.decision.outcome}</strong>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{artifact.decision.summary}</p>
            <div className="mt-4 flex items-center gap-2 border-t pt-3 font-mono text-[9px] uppercase tracking-[.08em] text-muted-foreground">
              <GitBranch aria-hidden size={13} />
              {artifact.changeSet.files.length} {t("guardrails.changedFiles")}
            </div>
          </div>
          <div className="absolute bottom-0 left-1/2 top-1/2 hidden border-l border-primary/35 lg:block" aria-hidden />
        </div>

        <div className="min-w-0 divide-y">
          {tree.files.map((file, fileIndex) => (
            <div key={file.path} className="grid min-w-0 bg-background lg:grid-cols-[minmax(14rem,.38fr)_minmax(0,1fr)]">
              <div className="relative min-w-0 border-b bg-secondary/[.06] px-4 py-4 lg:border-b-0 lg:border-r">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center border border-primary/45 text-primary">
                    <FileCode2 aria-hidden size={14} />
                  </span>
                  <div className="min-w-0">
                    <div className="bench-label">{String(fileIndex + 1).padStart(2, "0")} / {t("guardrails.file")}</div>
                    <div className="mt-1 break-all font-mono text-[10px] leading-5">{file.path}</div>
                    <div className="mt-2 text-[10px] text-muted-foreground">{file.findings.length} {file.findings.length === 1 ? t("guardrails.finding") : t("guardrails.findings")}</div>
                  </div>
                </div>
                <span className="absolute -right-2 top-7 z-10 hidden size-4 rotate-45 border-r border-t bg-background lg:block" aria-hidden />
              </div>
              <div className="relative min-w-0 space-y-2 p-3 before:absolute before:bottom-4 before:left-5 before:top-4 before:border-l before:border-primary/25">
                {file.findings.map((leaf, findingIndex) => {
                  const selected = leaf.id === selectedNodeId;
                  return (
                    <button
                      key={leaf.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelect(leaf.node)}
                      className={cx(
                        "relative z-10 grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border bg-background px-3 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                        toneClasses[leaf.node.tone],
                        selected && "bg-primary/[.07] ring-1 ring-primary shadow-[inset_3px_0_var(--primary)]",
                      )}
                    >
                      <span className={cx("mt-0.5 flex size-7 shrink-0 items-center justify-center border", toneClasses[leaf.node.tone], selected && "bg-primary text-primary-foreground")}>
                        <ToneIcon tone={leaf.node.tone} />
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={leaf.finding.severity} />
                          <span className="font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">{leaf.finding.lifecycle}</span>
                          <span className="font-mono text-[8px] text-muted-foreground">#{findingIndex + 1}</span>
                        </span>
                        <strong className="mt-1.5 block break-words text-xs leading-5">{leaf.finding.title}</strong>
                        {leaf.finding.category && <span className="mt-1 block text-[10px] text-muted-foreground">{leaf.finding.category}</span>}
                      </span>
                      <ChevronRight aria-hidden size={14} className="mt-2 shrink-0 text-muted-foreground" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {tree.files.length === 0 && <p className="p-6 text-sm text-muted-foreground">{t("guardrails.noFindings")}</p>}
        </div>
      </div>
    </section>
  );
}

function TreeMetric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "risk" }) {
  return (
    <div className="min-w-0 border-b border-r px-3 py-2.5">
      <div className="bench-label">{label}</div>
      <div className={cx("mt-1 font-mono text-lg", tone === "risk" && "text-destructive")}>{value}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const classes = severity === "critical" || severity === "high"
    ? "border-destructive/55 text-destructive"
    : severity === "medium"
      ? "border-chart-3/55 text-chart-3"
      : "border-border text-muted-foreground";
  return <span className={cx("border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[.08em]", classes)}>{severity}</span>;
}
