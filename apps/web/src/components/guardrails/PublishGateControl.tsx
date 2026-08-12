import { useState } from "react";
import type { GateArtifact, GateRun } from "@csb/shared";
import { ExternalLink, RotateCw, Send } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../../api";
import { prCheckLabel, publicationTarget } from "../../lib/github-guardrails";
import { AlertBanner } from "../ui";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { GateOutcomeBadge } from "./GateOutcomeBadge";

export function PublishGateControl({
  gate,
  artifact,
  onGateChange,
}: {
  gate: GateRun;
  artifact: GateArtifact;
  onGateChange: (gate: GateRun) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const target = publicationTarget(artifact);
  const configured = gate.publishStatus !== "not_configured";
  const publishable = gate.status === "completed" && Boolean(artifact.repository.owner) && Boolean(target.headSha);
  const finished = gate.publishStatus === "published";
  const actionsOwned = gate.executor === "github-actions";

  async function publish() {
    setBusy(true);
    setActionError(null);
    try {
      const response = await api.publishGate(gate.id);
      onGateChange(response.gate);
      setConfirmOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao publicar GitHub Check");
      try {
        const response = await api.getGate(gate.id);
        onGateChange(response.gate);
      } catch {
        // Keep the last proven local decision visible when refresh also fails.
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bench-panel min-w-0 overflow-hidden" aria-labelledby="publish-gate-title">
      <div className="grid min-w-0 lg:grid-cols-[minmax(14rem,.55fr)_minmax(0,1.45fr)_minmax(13rem,.55fr)]">
        <div className="border-b px-4 py-3 lg:border-b-0 lg:border-r">
          <div className="bench-label text-primary">PR CHECK / PUBLICATION</div>
          <h2 id="publish-gate-title" className="mt-1 font-heading text-sm font-semibold">Publicar a decisão existente</h2>
          <div className="mt-3"><GateOutcomeBadge outcome={gate.outcome} status={gate.status} /></div>
        </div>
        <div className="grid min-w-0 grid-cols-1 border-b sm:grid-cols-2 lg:border-b-0 lg:border-r">
          <Readout label="Owner / repo" value={target.repository} />
          <Readout label="Head SHA" value={target.headSha || "Não determinado"} mono />
          <div className="border-t px-4 py-3 sm:col-span-2">
            <p className="text-xs leading-5 text-muted-foreground">O Check recebe a conclusão derivada do artifact. Falha de publicação não altera o outcome local exibido acima.</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-between gap-3 px-4 py-3">
          <div>
            <div className="bench-label">ESTADO DO PR CHECK</div>
            <div className="mt-1 break-words font-mono text-[10px] font-semibold text-foreground">{prCheckLabel(gate)}</div>
            {gate.publishError && <p className="mt-2 break-words text-xs leading-5 text-destructive">{gate.publishError}</p>}
          </div>
          {actionsOwned ? (
            <div className="border border-info/35 bg-info/[.05] p-3">
              <div className="bench-label text-info">ACTIONS OWNED</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">O workflow publica ou atualiza o Check usando o gate ID. O Sentinel apenas reconcilia o resultado; não existe botão de publicação manual.</p>
              {gate.workflowRunId && <div className="mt-2 break-all font-mono text-[9px] text-foreground">RUN {gate.workflowRunId}</div>}
            </div>
          ) : !configured ? (
            <Button asChild variant="outline" className="min-h-11 w-full"><Link to={`/guardrails/setup?repository=${encodeURIComponent(gate.repositoryKey)}`}><ExternalLink aria-hidden size={14} />Configurar GitHub</Link></Button>
          ) : finished ? (
            <Button variant="outline" className="min-h-11 w-full" disabled><Send aria-hidden size={14} />Check publicado</Button>
          ) : (
            <Button className="min-h-11 w-full" disabled={busy || !publishable} onClick={() => setConfirmOpen(true)}>
              {gate.publishStatus === "failed" ? <RotateCw aria-hidden size={14} /> : <Send aria-hidden size={14} />}
              {busy || gate.publishStatus === "publishing" ? "Publicando…" : gate.publishStatus === "failed" ? "Tentar publicar novamente" : "Publicar Check"}
            </Button>
          )}
        </div>
      </div>

      {actionError && <div className="border-t"><AlertBanner>{actionError}</AlertBanner></div>}

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="bottom" className="mx-auto max-h-[85dvh] overflow-y-auto border-border bg-background sm:left-1/2 sm:max-w-2xl sm:-translate-x-1/2">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-heading"><Send aria-hidden size={17} className="text-primary" />Confirmar publicação do Check</SheetTitle>
            <SheetDescription>Confirme o destino exato. Esta ação publica um GitHub Check; não recalcula nem modifica a decisão local.</SheetDescription>
          </SheetHeader>
          <div className="mx-4 grid border sm:grid-cols-2">
            <Readout label="Owner / repo" value={target.repository} />
            <Readout label="Head SHA" value={target.headSha || "Não determinado"} mono />
          </div>
          <SheetFooter className="sm:flex-row sm:justify-end">
            <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancelar</Button>
            <Button className="min-h-11" disabled={busy || !publishable} onClick={() => void publish()}><Send aria-hidden size={14} />{busy ? "Publicando…" : "Confirmar publicação"}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function Readout({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="bench-label">{label}</div>
      <div className={`mt-1 break-all text-xs ${mono ? "font-mono" : "font-medium"}`}>{value}</div>
    </div>
  );
}
