import type { AttackPathNode as AttackPathNodeModel } from "@csb/shared";
import { AlertTriangle, Check, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cx } from "../ui";

const kindLabel: Record<AttackPathNodeModel["kind"], string> = {
  attacker: "Ator",
  source: "Origem",
  entrypoint: "Entrada",
  implementation: "Implementação",
  control: "Controle",
  sink: "Destino",
  evidence: "Evidência",
  outcome: "Impacto",
};

const stateLabel: Record<AttackPathNodeModel["evidenceState"], string> = {
  proven: "provado",
  inferred: "inferido",
  missing: "lacuna",
};

const stateTone: Record<AttackPathNodeModel["evidenceState"], string> = {
  proven: "border-chart-2/45 text-chart-2",
  inferred: "border-chart-3/45 text-chart-3",
  missing: "border-destructive/55 text-destructive",
};

function EvidenceStateIcon({ state }: { state: AttackPathNodeModel["evidenceState"] }) {
  if (state === "proven") return <Check aria-hidden size={11} strokeWidth={2} />;
  if (state === "missing") return <AlertTriangle aria-hidden size={11} strokeWidth={1.7} />;
  return <CircleDashed aria-hidden size={11} strokeWidth={1.7} />;
}

export function AttackPathNode({
  node,
  index,
  selected,
  onSelect,
}: {
  node: AttackPathNodeModel;
  index: number;
  selected: boolean;
  onSelect: (node: AttackPathNodeModel) => void;
}) {
  const location = node.location
    ? `${node.location.path}${node.location.startLine != null ? `:${node.location.startLine}` : ""}`
    : null;

  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={selected}
      data-evidence-state={node.evidenceState}
      onClick={() => onSelect(node)}
      className={cx(
        "group h-auto min-h-28 w-full min-w-0 items-stretch justify-start whitespace-normal border bg-card/65 p-0 text-left hover:bg-accent sm:w-44 sm:min-w-44",
        node.evidenceState === "missing" && "border-dashed",
        selected && "border-primary bg-primary/[.07] shadow-[inset_0_-2px_0_var(--primary)]",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center justify-between gap-3 border-b px-3 py-2 font-mono text-[8px] uppercase tracking-[.13em]">
          <span className={selected ? "text-primary" : "text-muted-foreground"}>
            {String(index + 1).padStart(2, "0")} / {kindLabel[node.kind]}
          </span>
          <span className={cx("inline-flex items-center gap-1", stateTone[node.evidenceState])}>
            <EvidenceStateIcon state={node.evidenceState} />
            {stateLabel[node.evidenceState]}
          </span>
        </span>
        <span className="min-w-0 px-3 py-3">
          <span
            title={node.label}
            className="block max-h-[3.75rem] overflow-hidden break-words text-xs font-semibold leading-5 text-foreground"
          >
            {node.label}
          </span>
          {location && (
            <span className="mt-2 block truncate font-mono text-[8px] font-normal text-primary/80">
              {location}
            </span>
          )}
          {!location && node.summary && (
            <span className="mt-2 line-clamp-2 block text-[10px] font-normal leading-4 text-muted-foreground">
              {node.summary}
            </span>
          )}
        </span>
      </span>
    </Button>
  );
}
