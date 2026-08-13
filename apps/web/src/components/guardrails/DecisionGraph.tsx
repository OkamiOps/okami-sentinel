import type { DecisionGraphNode as DecisionNode } from "@csb/shared";
import { ArrowDown, ArrowRight, Check, CircleAlert, CircleDot, X } from "lucide-react";

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
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: readonly DecisionNode[];
  selectedNodeId: string | null;
  onSelect: (node: DecisionNode) => void;
}) {
  return (
    <section className="bench-panel min-w-0" aria-labelledby="decision-graph-title">
      <div className="border-b px-4 py-3">
        <div className="bench-label text-primary">DECISION GRAPH</div>
        <h2 id="decision-graph-title" className="mt-1 font-heading text-base font-semibold">
          Cadeia causal do gate
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
          Selecione uma etapa para abrir a evidência que sustentou a decisão.
        </p>
      </div>
      <div className="flex flex-col p-3 md:grid md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] md:items-stretch md:p-4">
        {nodes.map((node, index) => {
          const selected = node.id === selectedNodeId;
          return (
            <div key={node.id} className="contents">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(node)}
                className={cx(
                  "group flex min-h-14 min-w-0 items-start gap-3 border bg-background px-3 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none md:min-h-28 md:flex-col",
                  toneClasses[node.tone],
                  selected && "bg-primary/[.07] ring-1 ring-primary shadow-[inset_0_3px_0_var(--primary)]",
                )}
              >
                <span className={cx("flex size-7 shrink-0 items-center justify-center border", toneClasses[node.tone], selected && "bg-primary text-primary-foreground")}>
                  <ToneIcon tone={node.tone} />
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground">
                    {String(index + 1).padStart(2, "0")} / {node.label}
                  </span>
                  <span className="mt-1 block break-words text-xs font-semibold leading-5">
                    {node.value || "Não determinado"}
                  </span>
                </span>
              </button>
              {index < nodes.length - 1 && (
                <span className="flex h-7 items-center justify-center text-muted-foreground md:h-auto md:w-7" aria-hidden>
                  <ArrowDown size={14} className="md:hidden" />
                  <ArrowRight size={14} className="hidden md:block" />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
