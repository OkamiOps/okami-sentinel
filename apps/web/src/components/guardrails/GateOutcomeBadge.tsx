import type { GateOutcome, GateStatus } from "@csb/shared";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  LoaderCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cx } from "../ui";
import { gateOutcomeTone, gateStageLabel } from "../../lib/guardrails";

const outcomeLabels: Record<GateOutcome, string> = {
  no_changes: "Sem mudanças",
  bootstrap: "Baseline ausente",
  pass: "Aprovado",
  warning: "Revisão necessária",
  blocked: "Bloqueado",
  error: "Erro",
};

const toneClass = {
  neutral: "border-border bg-transparent text-muted-foreground",
  good: "border-chart-2/45 bg-chart-2/8 text-chart-2",
  warning: "border-chart-3/45 bg-chart-3/8 text-chart-3",
  risk: "border-destructive/50 bg-destructive/8 text-destructive",
  active: "border-primary/50 bg-primary/8 text-primary",
} as const;

function OutcomeIcon({ outcome }: { outcome: GateOutcome }) {
  if (outcome === "pass") return <CircleCheck aria-hidden />;
  if (outcome === "no_changes") return <CircleMinus aria-hidden />;
  if (outcome === "blocked" || outcome === "error") return <CircleX aria-hidden />;
  return <CircleAlert aria-hidden />;
}

export function GateOutcomeBadge({
  outcome,
  status,
}: {
  outcome: GateOutcome | null;
  status: GateStatus;
}) {
  const active = ["queued", "resolving", "scanning", "evaluating", "publishing"].includes(status);
  const tone = active ? "active" : gateOutcomeTone(outcome);
  return (
    <Badge
      variant="outline"
      className={cx(
        "h-6 rounded-none px-2 font-mono text-[9px] uppercase tracking-[0.08em]",
        toneClass[tone],
      )}
    >
      {active ? (
        <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
      ) : outcome ? (
        <OutcomeIcon outcome={outcome} />
      ) : status === "cancelled" ? (
        <CircleMinus aria-hidden />
      ) : (
        <CircleDashed aria-hidden />
      )}
      {active ? gateStageLabel(status) : outcome ? outcomeLabels[outcome] : gateStageLabel(status)}
    </Badge>
  );
}
