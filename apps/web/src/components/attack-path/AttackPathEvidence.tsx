import type { AttackPathNode } from "@csb/shared";
import { AlertTriangle, Copy, FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, cx } from "../ui";

const kindLabel: Record<AttackPathNode["kind"], string> = {
  attacker: "Ator",
  source: "Origem controlada",
  entrypoint: "Ponto de entrada",
  implementation: "Implementação concreta",
  control: "Controle mais próximo",
  sink: "Consumidor protegido",
  evidence: "Evidência corroborante",
  outcome: "Resultado",
};

function locationLabel(node: AttackPathNode): string | null {
  if (!node.location) return null;
  const { path, startLine, endLine } = node.location;
  if (startLine == null) return path;
  return `${path}:${startLine}${endLine != null && endLine !== startLine ? `–${endLine}` : ""}`;
}

export function AttackPathEvidence({
  node,
  compact = false,
}: {
  node: AttackPathNode | null;
  compact?: boolean;
}) {
  if (!node) {
    return (
      <EmptyState
        title="Etapa sem evidência"
        description="Selecione uma etapa do caminho para inspecionar sua origem."
      />
    );
  }

  const location = locationLabel(node);
  const explanation = node.explanation ?? node.summary;
  return (
    <section className="min-w-0 border-t" aria-live="polite">
      <div className="grid min-w-0 gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="bench-label text-primary">{kindLabel[node.kind]}</span>
            <span
              className={cx(
                "border px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-wider",
                node.evidenceState === "proven" && "border-chart-2/40 text-chart-2",
                node.evidenceState === "inferred" && "border-chart-3/40 text-chart-3",
                node.evidenceState === "missing" && "border-destructive/45 text-destructive",
              )}
            >
              {node.evidenceState === "proven"
                ? "evidência provada"
                : node.evidenceState === "inferred"
                  ? "contexto inferido"
                  : "lacuna explícita"}
            </span>
          </div>
          <h3 className="mt-2 break-words text-sm font-semibold leading-6">{node.label}</h3>
          {location && (
            <p className="mt-1 break-all font-mono text-[9px] leading-5 text-primary/85">
              {location}
            </p>
          )}
          {explanation && (
            <p className="mt-3 max-w-3xl break-words text-xs leading-6 text-muted-foreground">
              {explanation}
            </p>
          )}
        </div>
        {node.code && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void navigator.clipboard.writeText(node.code ?? "")}
          >
            <Copy aria-hidden size={12} />Copiar trecho
          </Button>
        )}
      </div>

      {node.evidenceState === "missing" && (
        <div className="flex items-start gap-3 border-t border-destructive/30 bg-destructive/[.04] px-4 py-4 text-xs leading-6 text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-1 shrink-0 text-destructive" size={14} />
          <p>
            A referência existe na cadeia, mas o artefato correspondente não foi anexado.
            A interface mantém a lacuna visível; ela não inventa uma ligação.
          </p>
        </div>
      )}

      {node.code && (
        <div className="min-w-0 border-t bg-[var(--surface-code)]">
          <div className="flex items-center justify-between border-b px-4 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <FileCode2 aria-hidden size={12} />{node.language ?? "source"}
            </span>
            <span>{node.evidenceRef}</span>
          </div>
          <pre
            className={cx(
              "max-w-full overflow-auto whitespace-pre py-3 font-mono text-[10px] leading-5 text-secondary-foreground [tab-size:2]",
              compact ? "max-h-52" : "max-h-[34rem]",
            )}
          >
            <code className="block min-w-max">
              {node.code.split("\n").map((line, lineIndex) => (
                <span key={lineIndex} className="grid grid-cols-[3.5rem_minmax(0,1fr)]">
                  <span className="select-none border-r border-border/70 pr-3 text-right text-muted-foreground/45">
                    {node.location?.startLine != null
                      ? node.location.startLine + lineIndex
                      : lineIndex + 1}
                  </span>
                  <span className="px-3">{line || " "}</span>
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
    </section>
  );
}
