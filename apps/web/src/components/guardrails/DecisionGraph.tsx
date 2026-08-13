import type { DecisionGraphNode as DecisionNode, GateArtifact, Severity } from "@csb/shared";
import { Check, ChevronRight, CircleAlert, CircleDot, FileCode2, GitBranch, ShieldCheck, X } from "lucide-react";

import { buildFindingTree } from "../../lib/guardrails";
import { useI18n } from "../../i18n";
import { cx } from "../ui";

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
  const leaves = tree.files.flatMap((file) => file.findings);
  const leafOrdinals = new Map(leaves.map((leaf, index) => [leaf.id, index + 1]));
  const verdictTone = artifact.decision.outcome === "blocked" || artifact.decision.outcome === "error"
    ? "risk"
    : artifact.decision.outcome === "warning" || artifact.decision.outcome === "bootstrap"
      ? "warning"
      : "good";

  return (
    <section className="bench-panel min-w-0 overflow-hidden" aria-labelledby="decision-graph-title">
      <div className="border-b px-4 py-4">
        <div className="bench-label text-primary">{t("guardrails.findingTreeEyebrow")}</div>
        <h2 id="decision-graph-title" className="mt-1 font-heading text-base font-semibold">
          {t("guardrails.findingTreeTitle")}
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
          {t("guardrails.findingTreeDescription")}
        </p>
      </div>

      <div className="border-b bg-secondary/[.06] p-4">
        <div className={cx("grid min-w-0 gap-4 border bg-background p-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center", toneClasses[verdictTone])}>
          <span className={cx("grid size-10 place-items-center border", toneClasses[verdictTone])}>
            <ShieldCheck aria-hidden size={17} />
          </span>
          <div className="min-w-0">
            <div className="bench-label">ROOT / {t("guardrails.verdict")}</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <strong className="font-heading text-xl uppercase">{artifact.decision.outcome}</strong>
              <span className="text-xs leading-5 text-muted-foreground">{artifact.decision.summary}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.08em] text-muted-foreground">
              <GitBranch aria-hidden size={12} />
              {artifact.changeSet.files.length} {t("guardrails.changedFiles")}
            </div>
          </div>
          <div className="grid grid-cols-3 border-l border-t md:min-w-[17rem]">
            <TreeMetric label={t("guardrails.files")} value={tree.files.length} />
            <TreeMetric label={t("guardrails.findings")} value={tree.findingCount} />
            <TreeMetric label="HIGH+" value={tree.highPlusCount} tone="risk" />
          </div>
        </div>
      </div>

      <div className="relative min-w-0 px-3 py-4 sm:px-5">
        <div className="absolute bottom-7 left-7 top-0 border-l border-primary/35 sm:left-9" aria-hidden />
        <div className="space-y-4">
          {tree.files.map((file, fileIndex) => {
            const { directory, basename } = splitPath(file.path);
            return (
              <article key={file.path} className="relative min-w-0 pl-8 sm:pl-10">
                <span className="absolute left-4 top-4 w-4 border-t border-primary/35 sm:left-4 sm:w-6" aria-hidden />
                <div className="relative z-10 flex min-w-0 items-start gap-3 border-b pb-3">
                  <span className="grid size-8 shrink-0 place-items-center border border-primary/55 bg-background text-primary">
                    <FileCode2 aria-hidden size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="bench-label text-primary">FILE {String(fileIndex + 1).padStart(2, "0")}</span>
                      <span className="font-mono text-[9px] text-muted-foreground">
                        {file.findings.length} {file.findings.length === 1 ? t("guardrails.finding") : t("guardrails.findings")}
                      </span>
                    </div>
                    <strong className="mt-1 block break-all text-sm leading-5">{basename}</strong>
                    {directory && <span className="mt-0.5 block break-all font-mono text-[9px] leading-4 text-muted-foreground">{directory}/</span>}
                  </div>
                </div>

                <ol className="relative ml-4 mt-2 space-y-2 border-l border-border/80 pl-5 sm:ml-5 sm:pl-6">
                  {file.findings.map((leaf) => {
                    const selected = leaf.id === selectedNodeId;
                    const ordinal = leafOrdinals.get(leaf.id) ?? 0;
                    return (
                      <li key={leaf.id} className="relative min-w-0">
                        <span className="absolute -left-5 top-6 w-5 border-t border-border/80 sm:-left-6 sm:w-6" aria-hidden />
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => onSelect(leaf.node)}
                          className={cx(
                            "group grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border bg-background px-3 py-3 text-left transition-[background-color,border-color,transform] hover:translate-x-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none",
                            toneClasses[leaf.node.tone],
                            selected && "translate-x-0.5 border-primary bg-primary/[.08] text-foreground shadow-[inset_3px_0_var(--primary),0_0_24px_color-mix(in_oklab,var(--primary)_10%,transparent)]",
                          )}
                        >
                          <span className={cx("mt-0.5 flex size-7 shrink-0 items-center justify-center border", toneClasses[leaf.node.tone], selected && "border-primary bg-primary text-primary-foreground")}>
                            <ToneIcon tone={leaf.node.tone} />
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-[8px] uppercase tracking-[.12em] text-muted-foreground">V-{String(ordinal).padStart(2, "0")}</span>
                              <SeverityBadge severity={leaf.finding.severity} />
                              <span className="font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">{leaf.finding.lifecycle}</span>
                            </span>
                            <strong className="mt-1.5 block break-words text-xs leading-5">{leaf.finding.title}</strong>
                            {leaf.finding.category && <span className="mt-1 block text-[10px] text-muted-foreground">{leaf.finding.category}</span>}
                          </span>
                          <ChevronRight aria-hidden size={14} className={cx("mt-2 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none", selected && "text-primary")} />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </article>
            );
          })}
          {tree.files.length === 0 && <p className="pl-8 text-sm text-muted-foreground">{t("guardrails.noFindings")}</p>}
        </div>
      </div>
    </section>
  );
}

function splitPath(path: string): { directory: string; basename: string } {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return { directory: "", basename: path };
  return { directory: path.slice(0, separator), basename: path.slice(separator + 1) };
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
