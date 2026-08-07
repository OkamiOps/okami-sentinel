import type { DecisionGraphNode, GateArtifact } from "@csb/shared";
import { ArrowUpRight, FileSearch } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { evidenceForNode } from "../../lib/guardrails";

export function EvidenceTrace({ artifact, node }: { artifact: GateArtifact; node: DecisionGraphNode }) {
  const evidence = evidenceForNode(artifact, node);
  const finding = evidence.finding;
  const attackPathHref = finding?.sourceScanId && finding.findingId
    ? `/scans/${encodeURIComponent(finding.sourceScanId)}/findings/${encodeURIComponent(finding.findingId)}/path?evidenceScan=${encodeURIComponent(finding.sourceScanId)}`
    : null;

  return (
    <section className="bench-panel min-w-0" aria-labelledby="evidence-trace-title">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <div className="bench-label text-primary">EVIDENCE TRACE</div>
          <h2 id="evidence-trace-title" className="mt-0.5 text-sm font-semibold">{evidence.title}</h2>
        </div>
        <FileSearch aria-hidden size={16} className="text-muted-foreground" />
      </div>
      <div className="p-4">
        <p className="max-w-3xl break-words text-sm leading-6">{evidence.summary}</p>
        <dl className="mt-4 grid border-l border-t sm:grid-cols-2">
          {evidence.rows.map((row) => (
            <div key={row.label} className="min-w-0 border-b border-r px-3 py-3">
              <dt className="bench-label">{row.label}</dt>
              <dd className="mt-1 break-words font-mono text-[10px] leading-5 text-muted-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
        {attackPathHref && (
          <Button asChild variant="outline" className="mt-4 min-h-11 w-full justify-between sm:w-auto">
            <Link to={attackPathHref}>
              Abrir no Attack Path <ArrowUpRight aria-hidden size={14} />
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}
