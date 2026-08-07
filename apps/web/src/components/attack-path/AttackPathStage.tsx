import type { AttackPathLane, AttackPathNode as AttackPathNodeModel } from "@csb/shared";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getAttackPathStageItems } from "@/lib/attack-path";
import { cx } from "../ui";
import { AttackPathNode } from "./AttackPathNode";

function Connector() {
  return (
    <span aria-hidden className="relative flex h-8 shrink-0 items-center justify-center text-muted-foreground/55 sm:h-auto sm:w-8">
      <span className="h-full w-px bg-border sm:h-px sm:w-full" />
      <ChevronDown className="absolute sm:hidden" size={13} />
      <ChevronRight className="absolute hidden sm:block" size={13} />
    </span>
  );
}

export function AttackPathStage({
  lane,
  selectedNodeId,
  onSelect,
  compact = false,
  expandHref,
  className,
}: {
  lane: AttackPathLane;
  selectedNodeId?: string | null;
  onSelect: (node: AttackPathNodeModel) => void;
  compact?: boolean;
  expandHref?: string;
  className?: string;
}) {
  const items = getAttackPathStageItems(lane, compact);
  return (
    <div
      className={cx(
        "min-w-0 max-w-full overflow-x-hidden sm:overflow-x-auto sm:overscroll-x-contain",
        className,
      )}
      aria-label={`Caminho de ataque: ${lane.label}`}
    >
      <ol className="flex min-w-0 flex-col sm:w-max sm:min-w-full sm:flex-row sm:items-stretch">
        {items.map((item, renderedIndex) => (
          <li
            key={item.type === "node" ? item.node.id : item.id}
            className="flex min-w-0 flex-col sm:flex-row sm:items-stretch"
          >
            {item.type === "node" ? (
              <AttackPathNode
                node={item.node}
                index={lane.nodes.indexOf(item.node)}
                selected={selectedNodeId === item.node.id}
                onSelect={onSelect}
              />
            ) : expandHref ? (
              <Button
                asChild
                variant="outline"
                className="h-auto min-h-20 w-full min-w-0 flex-col gap-1 border-dashed px-4 text-muted-foreground hover:text-primary sm:min-h-28 sm:min-w-32"
              >
                <Link to={expandHref}>
                  <MoreHorizontal aria-hidden size={16} />
                  <span className="font-mono text-[8px] uppercase tracking-wider">
                    {item.count} etapas
                  </span>
                  <span className="text-[9px] font-normal">abrir fluxo</span>
                </Link>
              </Button>
            ) : (
              <div className="flex min-h-20 min-w-0 flex-col items-center justify-center border border-dashed px-4 text-muted-foreground sm:min-h-28 sm:min-w-32">
                <MoreHorizontal aria-hidden size={16} />
                <span className="mt-1 font-mono text-[8px] uppercase tracking-wider">
                  {item.count} etapas
                </span>
              </div>
            )}
            {renderedIndex < items.length - 1 && <Connector />}
          </li>
        ))}
      </ol>
    </div>
  );
}
