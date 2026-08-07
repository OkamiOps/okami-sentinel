import { useState } from "react";
import type { GuardrailGitHubStatus, GuardrailRepository } from "@csb/shared";
import { Check, Clipboard, FilePlus2, KeyRound, Laptop2, RotateCw, ShieldAlert } from "lucide-react";

import {
  githubSetupModel,
  type GitHubSetupStep,
  type ScannerAccessMode,
} from "../../lib/github-guardrails";
import { cx } from "../ui";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const WORKFLOW_PATH = ".github/workflows/csb-security-change-gate.yml";

export function GitHubStatusPanel({
  repository,
  status,
  busy,
  accessMode,
  onAccessModeChange,
  onInstallWorkflow,
  onSyncBaseline,
}: {
  repository: GuardrailRepository;
  status: GuardrailGitHubStatus;
  busy: boolean;
  accessMode: ScannerAccessMode;
  onAccessModeChange: (mode: ScannerAccessMode) => void;
  onInstallWorkflow: () => Promise<void>;
  onSyncBaseline: () => Promise<void>;
}) {
  const model = githubSetupModel(status, repository, accessMode);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(step: GitHubSetupStep) {
    if (!step.command) return;
    await navigator.clipboard.writeText(step.command);
    setCopied(step.id);
  }

  async function install() {
    await onInstallWorkflow();
    setConfirmOpen(false);
  }

  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="github-capability-title">
      <div className="grid border-b lg:grid-cols-[minmax(14rem,.4fr)_minmax(0,1fr)]">
        <div className="border-b px-4 py-4 lg:border-b-0 lg:border-r">
          <div className="bench-label text-primary">SCANNER ACCESS</div>
          <h2 className="mt-1 font-heading text-base font-semibold">Como o scan será autenticado?</h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">Escolha a credencial que você realmente usa. O modo pode ser trocado a qualquer momento.</p>
        </div>
        <div className="grid sm:grid-cols-2" role="radiogroup" aria-label="Modo de autenticação do scanner">
          <AccessModeButton
            active={accessMode === "subscription"}
            icon={<Laptop2 aria-hidden size={17} />}
            title="Assinatura Codex"
            meta="LOCAL / SEM SECRET"
            description="Usa a sessão ChatGPT/Codex deste Mac para o preflight local e permite publicar o resultado via gh."
            onClick={() => onAccessModeChange("subscription")}
          />
          <AccessModeButton
            active={accessMode === "api"}
            icon={<KeyRound aria-hidden size={17} />}
            title="API"
            meta="CI / GITHUB ACTIONS"
            description="Usa OPENAI_API_KEY no repositório para executar o gate automaticamente em PRs, sem depender deste Mac."
            onClick={() => onAccessModeChange("api")}
          />
        </div>
      </div>
      <div className="grid border-b lg:grid-cols-[minmax(0,1fr)_minmax(22rem,.55fr)]">
        <div className="px-4 py-3 lg:border-r">
          <div className="bench-label text-primary">GITHUB CAPABILITY TRACE</div>
          <h2 id="github-capability-title" className="mt-1 font-heading text-base font-semibold">Pré-requisitos para publicar Checks</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{accessMode === "subscription" ? "Verifica a sessão Codex local e as capacidades necessárias para publicar o resultado pelo GitHub CLI." : "Verifica o secret e o workflow necessários para automatizar o gate no GitHub Actions."}</p>
        </div>
        <div className={cx("border-t px-4 py-3 lg:border-t-0", model.ready ? "bg-chart-2/[.06]" : "bg-primary/[.06]")}>
          <div className="bench-label">{model.ready ? "CAPACIDADE" : "PRÓXIMO BLOQUEIO"}</div>
          <div className="mt-1 flex items-start gap-2">
            {model.ready ? <Check aria-hidden size={15} className="mt-0.5 shrink-0 text-chart-2" /> : <ShieldAlert aria-hidden size={15} className="mt-0.5 shrink-0 text-primary" />}
            <div className="min-w-0">
              <div className="text-sm font-semibold">{model.primary.title}</div>
              {model.primary.command && <code className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{model.primary.command}</code>}
            </div>
          </div>
        </div>
      </div>

      <ol>
        {model.steps.map((step, index) => (
          <li key={step.id} className="grid min-w-0 border-b last:border-b-0 md:grid-cols-[3.25rem_minmax(11rem,.65fr)_minmax(0,1.35fr)_minmax(11rem,.55fr)]">
            <div className="flex min-h-11 items-center border-b px-4 font-mono text-[9px] text-muted-foreground md:border-b-0 md:border-r">{String(index + 1).padStart(2, "0")}</div>
            <div className="flex min-w-0 items-center gap-2 border-b px-4 py-3 md:border-b-0 md:border-r">
              <span className={cx("size-2 shrink-0 rounded-full", step.ready ? "bg-chart-2" : "bg-destructive")} aria-hidden />
              <div>
                <div className="text-xs font-semibold">{step.title}</div>
                <div className={cx("mt-1 font-mono text-[8px] uppercase", step.ready ? "text-chart-2" : "text-destructive")}>{step.ready ? "PRONTO" : "AÇÃO NECESSÁRIA"}</div>
              </div>
            </div>
            <div className="min-w-0 border-b px-4 py-3 md:border-b-0 md:border-r">
              <p className="break-words text-xs leading-5">{step.message}</p>
              {step.action && <p className="mt-1 break-words font-mono text-[9px] text-muted-foreground">{step.action}</p>}
            </div>
            <div className="flex min-h-14 items-center px-4 py-2">
              <StepAction
                step={step}
                busy={busy}
                copied={copied === step.id}
                onCopy={() => void copy(step)}
                onInstall={() => setConfirmOpen(true)}
                onSync={() => void onSyncBaseline()}
              />
            </div>
          </li>
        ))}
      </ol>

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="bottom" className="mx-auto max-h-[85dvh] overflow-y-auto border-border bg-background sm:left-1/2 sm:max-w-2xl sm:-translate-x-1/2">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-heading"><FilePlus2 aria-hidden size={17} className="text-primary" />Instalar caller workflow</SheetTitle>
            <SheetDescription>Esta ação cria apenas um arquivo no workspace local. Ela não faz commit, push nem publica um workflow no GitHub.</SheetDescription>
          </SheetHeader>
          <div className="mx-4 border p-4">
            <div className="bench-label">CAMINHO EXATO</div>
            <code className="mt-2 block break-all font-mono text-sm text-primary">{WORKFLOW_PATH}</code>
          </div>
          <SheetFooter className="sm:flex-row sm:justify-end">
            <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancelar</Button>
            <Button className="min-h-11" disabled={busy} onClick={() => void install()}><FilePlus2 aria-hidden size={14} />{busy ? "Criando…" : "Confirmar instalação local"}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function AccessModeButton({
  active,
  icon,
  title,
  meta,
  description,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  meta: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="radio"
      aria-checked={active}
      className={cx(
        "h-auto min-h-28 w-full items-start justify-start gap-3 whitespace-normal rounded-none border-0 p-4 text-left sm:border-l",
        active ? "bg-primary/[.09] text-foreground hover:bg-primary/[.12]" : "text-muted-foreground",
      )}
      onClick={onClick}
    >
      <span className={cx("mt-0.5 grid size-8 shrink-0 place-items-center border", active ? "border-primary text-primary" : "border-border")}>{icon}</span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-heading text-sm font-semibold text-foreground">{title}</span>
          <span className={cx("font-mono text-[8px]", active ? "text-primary" : "text-muted-foreground")}>{meta}</span>
        </span>
        <span className="mt-2 block max-w-xl text-xs font-normal leading-5">{description}</span>
      </span>
    </Button>
  );
}

function StepAction({
  step,
  busy,
  copied,
  onCopy,
  onInstall,
  onSync,
}: {
  step: GitHubSetupStep;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onInstall: () => void;
  onSync: () => void;
}) {
  if (step.ready) return <span className="font-mono text-[9px] uppercase text-chart-2">Verificado</span>;
  if (step.actionKind === "install") return <Button variant="outline" className="min-h-11 w-full" disabled={busy} onClick={onInstall}><FilePlus2 aria-hidden size={14} />Instalar workflow</Button>;
  if (step.actionKind === "sync") return <Button variant="outline" className="min-h-11 w-full" disabled={busy} onClick={onSync}><RotateCw aria-hidden size={14} />Sincronizar baseline</Button>;
  if (step.actionKind === "copy" && step.command) return <Button variant="outline" className="min-h-11 w-full" disabled={busy} onClick={onCopy}><Clipboard aria-hidden size={14} />{copied ? "Copiado" : "Copiar ação"}</Button>;
  return <span className="text-xs text-muted-foreground">Resolva em Guardrails</span>;
}
