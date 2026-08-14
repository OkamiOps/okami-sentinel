import { useEffect, useMemo, useState } from "react";
import type { DecisionGraphNode, FindingDetail, GateArtifact } from "@csb/shared";
import { FileCode2, Route, ShieldAlert, Wrench } from "lucide-react";

import { api } from "@/api";
import { attackPathHref } from "@/lib/attack-path";
import { findingForDecisionNode } from "@/lib/guardrails";
import { useI18n } from "@/i18n";
import { AttackPathPreview } from "@/components/attack-path";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertBanner, Loading, SeverityBadge } from "@/components/ui";

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; finding: FindingDetail };

export function FindingInspectorDialog({
  artifact,
  node,
  open,
  onOpenChange,
}: {
  artifact: GateArtifact;
  node: DecisionGraphNode | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const signal = useMemo(() => node ? findingForDecisionNode(artifact, node) : null, [artifact, node]);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    let current = true;
    if (!open || !signal) {
      setState({ status: "idle" });
      return () => { current = false; };
    }
    setState({ status: "loading" });
    void api.getFinding(signal.sourceScanId, signal.findingId).then(({ finding }) => {
      if (current) setState({ status: "ready", finding });
    }).catch((error) => {
      if (current) setState({ status: "error", message: error instanceof Error ? error.message : t("guardrails.findingLoadError") });
    });
    return () => { current = false; };
  }, [open, signal?.sourceScanId, signal?.findingId, t]);

  const title = signal?.title ?? node?.label ?? t("guardrails.findingInspector");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[76rem]">
        <DialogHeader>
          <div className="bench-label text-primary">{t("guardrails.findingInspector")}</div>
          <DialogTitle className="mt-2 max-w-4xl break-words">{title}</DialogTitle>
          <DialogDescription>{t("guardrails.findingInspectorDescription")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!signal && <div className="p-5"><AlertBanner>{t("guardrails.findingUnavailable")}</AlertBanner></div>}
          {signal && state.status === "loading" && <div className="min-h-72"><Loading /></div>}
          {state.status === "error" && <div className="p-5"><AlertBanner>{state.message}</AlertBanner></div>}
          {signal && state.status === "ready" && (
            <div className="grid min-w-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
              <aside className="min-w-0 border-b bg-secondary/[.08] xl:border-b-0 xl:border-r">
                <div className="flex flex-wrap items-center gap-2 border-b p-4">
                  <SeverityBadge severity={signal.severity} />
                  <span className="border px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">{signal.lifecycle}</span>
                  <span className="border px-2 py-1 font-mono text-[8px] uppercase text-muted-foreground">{signal.confidence ?? t("common.unknown")}</span>
                </div>
                <InspectorFact icon={<FileCode2 aria-hidden size={13} />} label={t("guardrails.findingLocation")} value={state.finding.primaryPath ?? "—"} mono />
                <InspectorFact icon={<ShieldAlert aria-hidden size={13} />} label={t("guardrails.findingClassification")} value={[state.finding.category, ...state.finding.cwe].filter(Boolean).join(" · ") || "—"} />
                <InspectorFact icon={<Route aria-hidden size={13} />} label={t("guardrails.findingEvidence")} value={t("guardrails.findingEvidenceCount").replace("{count}", String(Array.isArray(state.finding.codeEvidence) ? state.finding.codeEvidence.length : 0))} />
                <div className="border-b p-4">
                  <div className="bench-label">{t("guardrails.findingSummary")}</div>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">{state.finding.summary ?? t("guardrails.findingNoSummary")}</p>
                </div>
                <div className="border-b p-4">
                  <div className="flex items-center gap-2 bench-label"><Wrench aria-hidden size={12} />{t("guardrails.findingRemediation")}</div>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">{humanText(state.finding.remediation) ?? t("guardrails.findingNoRemediation")}</p>
                </div>
                {humanText(state.finding.rootCause) && (
                  <div className="p-4">
                    <div className="bench-label">{t("guardrails.findingRootCause")}</div>
                    <p className="mt-2 text-xs leading-6 text-muted-foreground">{humanText(state.finding.rootCause)}</p>
                  </div>
                )}
              </aside>

              <main className="min-w-0">
                <AttackPathPreview
                  model={state.finding.attackPathModel}
                  hrefForSelection={(laneId, nodeId) => attackPathHref({
                    scanId: signal.sourceScanId,
                    findingId: signal.findingId,
                    evidenceScanId: signal.sourceScanId,
                    laneId,
                    nodeId,
                  })}
                />
              </main>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InspectorFact({ icon, label, value, mono = false }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b p-4">
      <div className="flex items-center gap-2 bench-label">{icon}{label}</div>
      <div className={mono ? "mt-2 break-all font-mono text-[9px] leading-5 text-primary" : "mt-2 break-words text-xs leading-5"}>{value}</div>
    </div>
  );
}

function humanText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(humanText).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(" · ") : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["summary", "description", "recommendation", "text", "detail", "steps"]) {
    const text = humanText(record[key]);
    if (text) return text;
  }
  return null;
}
