import { useState } from "react";
import type { GuardrailGitHubStatus, GuardrailRepository } from "@csb/shared";
import { Check, Clipboard, Download, GitBranch, RotateCw, ShieldAlert, Workflow } from "lucide-react";

import type { GuardrailActionsStatus, GuardrailCallerWorkflow } from "../../api";
import { Button } from "@/components/ui/button";
import { cx } from "../ui";

export function GitHubStatusPanel({
  repository,
  status,
  actionsStatus,
  callerWorkflow,
  busy,
  onRefresh,
  onSyncBaseline,
}: {
  repository: GuardrailRepository;
  status: GuardrailGitHubStatus;
  actionsStatus: GuardrailActionsStatus | null;
  callerWorkflow: GuardrailCallerWorkflow | null;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onSyncBaseline: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const remoteReady = status.remote.ready && status.auth.ready && status.permissions.ready;
  const managedReady = remoteReady;
  const actionsReady = remoteReady && actionsStatus?.ready === true;

  async function copyCaller() {
    if (!callerWorkflow) return;
    await navigator.clipboard.writeText(callerWorkflow.content);
    setCopied(true);
  }

  function downloadCaller() {
    if (!callerWorkflow) return;
    const href = URL.createObjectURL(new Blob([callerWorkflow.content], { type: callerWorkflow.mediaType }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = callerWorkflow.filename;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="github-capability-title">
      <div className="grid border-b lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="px-4 py-4">
          <div className="bench-label text-primary">GITHUB APP / TRUST CHAIN</div>
          <h2 id="github-capability-title" className="mt-1 font-heading text-base font-semibold">Autoridade remota e planos de execução</h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">O GitHub App substitui o requisito universal de pasta local e gh CLI. Cada executor continua com seu próprio contrato.</p>
        </div>
        <Button variant="outline" className="m-4 min-h-11" disabled={busy} onClick={() => void onRefresh()}><RotateCw aria-hidden size={14} />Atualizar capacidades</Button>
      </div>

      <div className="grid border-b md:grid-cols-3">
        <CapabilityCell icon={<GitBranch aria-hidden size={15} />} code="01 / AUTHORITY" title="GitHub App" ready={remoteReady} detail={status.remote.message} />
        <CapabilityCell icon={<ShieldAlert aria-hidden size={15} />} code="02 / MANAGED" title="Sentinel managed" ready={managedReady} detail={managedReady ? "Snapshot imutável autorizado pela instalação." : status.auth.message} />
        <CapabilityCell icon={<Workflow aria-hidden size={15} />} code="03 / ACTIONS" title="GitHub Actions" ready={actionsReady} detail={actionsStatus ? actionsStatusMessage(actionsStatus) : "Verificando caller fixado…"} />
      </div>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.45fr)]">
        <div className="min-w-0 border-b p-4 lg:border-b-0 lg:border-r">
          <div className="bench-label text-primary">ENROLLED IDENTITY</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <IdentityRow label="Repositório" value={`${repository.remoteOwner}/${repository.remoteName}`} />
            <IdentityRow label="Branch padrão" value={repository.defaultBranch} />
            <IdentityRow label="Installation ID" value={repository.githubInstallationId ?? "—"} />
            <IdentityRow label="Repository ID" value={repository.githubRepositoryId ?? "—"} />
            <IdentityRow label="Executor padrão" value={repository.defaultExecutor} />
            <IdentityRow label="Baseline" value={status.baseline.ready ? "AUTORIZADA" : "AÇÃO NECESSÁRIA"} />
          </div>
        </div>
        <div className="grid content-start gap-3 p-4">
          <div>
            <div className="bench-label">CALLER WORKFLOW</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">O Sentinel nunca faz commit ou push no repositório. Copie ou baixe o caller e publique pela revisão normal do projeto.</p>
          </div>
          <code className="block break-all border bg-secondary/30 p-3 font-mono text-[10px] text-primary">{actionsStatus?.workflowPath ?? ".github/workflows/csb-security-change-gate.yml"}</code>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <Button variant="outline" className="min-h-11" disabled={!callerWorkflow} onClick={() => void copyCaller()}><Clipboard aria-hidden size={14} />{copied ? "Copiado" : "Copiar YAML"}</Button>
            <Button variant="outline" className="min-h-11" disabled={!callerWorkflow} onClick={downloadCaller}><Download aria-hidden size={14} />Baixar arquivo</Button>
          </div>
          <Button className="min-h-11" disabled={busy || !remoteReady} onClick={() => void onSyncBaseline()}><RotateCw aria-hidden size={14} />Sincronizar baseline</Button>
        </div>
      </div>
    </section>
  );
}

function CapabilityCell({ icon, code, title, ready, detail }: { icon: React.ReactNode; code: string; title: string; ready: boolean; detail: string }) {
  return <div className="min-w-0 border-b p-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><div className={cx("bench-label", ready ? "text-chart-2" : "text-destructive")}>{code}</div><div className="mt-2 flex items-center gap-2"><span className={cx("grid size-7 place-items-center border", ready ? "border-chart-2/50 text-chart-2" : "border-destructive/50 text-destructive")}>{ready ? <Check aria-hidden size={14} /> : icon}</span><strong className="text-sm">{title}</strong></div><p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{detail}</p></div>;
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-l border-primary/40 pl-3"><div className="font-mono text-[8px] uppercase tracking-[.12em] text-muted-foreground">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-foreground">{value}</div></div>;
}

function actionsStatusMessage(status: GuardrailActionsStatus): string {
  const messages: Record<GuardrailActionsStatus["code"], string> = {
    ready: "Caller ativo e fixado no release imutável do Sentinel.",
    actions_release_unavailable: "Release imutável ainda não publicado.",
    caller_workflow_inactive: "O caller existe, mas está inativo no GitHub.",
    caller_workflow_missing: "O caller ainda não existe na branch padrão.",
    caller_workflow_outdated: "O caller não corresponde ao release autorizado.",
    github_actions_unavailable: "A instalação não comprovou acesso ao Actions.",
  };
  return messages[status.code];
}
