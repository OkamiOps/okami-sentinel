import type { DecisionGraphNode } from "@csb/shared";
import { ArrowDown, ArrowRight, Equal } from "lucide-react";

export function DecisionEquation({ nodes }: { nodes: readonly DecisionGraphNode[] }) {
  return (
    <section className="bench-panel min-w-0" aria-labelledby="decision-equation-title">
      <div className="border-b px-4 py-2.5">
        <div className="bench-label text-primary">DECISION EQUATION</div>
        <h2 id="decision-equation-title" className="sr-only">Equação da decisão</h2>
      </div>
      <div className="flex flex-col gap-2 p-4 lg:flex-row lg:items-center">
        {nodes.map((node, index) => (
          <div key={node.id} className="contents">
            <div className="min-w-0 flex-1 border px-3 py-2.5">
              <div className="bench-label">{node.label}</div>
              <div className="mt-1 break-words text-xs font-medium">{node.value || "Não determinado"}</div>
            </div>
            {index < nodes.length - 1 && (
              <span className="flex items-center justify-center text-muted-foreground" aria-hidden>
                {index === nodes.length - 2 ? <Equal size={14} /> : <><ArrowDown size={14} className="lg:hidden" /><ArrowRight size={14} className="hidden lg:block" /></>}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
