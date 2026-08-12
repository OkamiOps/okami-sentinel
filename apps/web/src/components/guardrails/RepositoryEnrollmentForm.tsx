import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { Cloud, GitBranch, HardDrive, LockKeyhole, Plus, Radio, Workflow } from "lucide-react";

import {
  api,
  type EnrollGuardrailRepositoryRequest,
  type GitHubAppConnection,
  type GitHubAppInstallation,
  type GitHubInstallationRepository,
} from "../../api";
import {
  canEnrollGuardrailRepository,
  enrollmentRequest,
  initialEnrollmentState,
  selectEnrollmentConnection,
  selectEnrollmentInstallation,
  selectEnrollmentSource,
} from "../../lib/guardrails-enrollment";
import { AlertBanner } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChoiceCard } from "./ChoiceCard";
import { RepositoryDirectoryBrowser } from "./RepositoryDirectoryBrowser";

export function RepositoryEnrollmentForm({ active, busy, onEnroll }: {
  active: boolean;
  busy: boolean;
  onEnroll: (request: EnrollGuardrailRepositoryRequest) => Promise<void>;
}) {
  const [state, setState] = useState(initialEnrollmentState);
  const [connections, setConnections] = useState<GitHubAppConnection[]>([]);
  const [installations, setInstallations] = useState<GitHubAppInstallation[]>([]);
  const [repositories, setRepositories] = useState<GitHubInstallationRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);

  const selectedRepository = repositories.find((item) => item.repositoryId === state.repositoryId) ?? null;
  const availability = useMemo(() => ({
    managed: selectedRepository !== null && !selectedRepository.archived,
    actions: selectedRepository !== null && !selectedRepository.archived,
  }), [selectedRepository]);
  const canSubmit = canEnrollGuardrailRepository(state, availability);

  const loadConnections = useCallback(async (preferredId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.listGuardrailGitHubConnections();
      setConnections(next);
      if (preferredId && next.some((item) => item.id === preferredId)) {
        setState((current) => selectEnrollmentConnection(current, preferredId));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível listar conexões GitHub App");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || state.source !== "github") return;
    void loadConnections();
  }, [active, state.source, loadConnections]);

  useEffect(() => {
    if (!state.connectionId) {
      setInstallations([]);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    void api.listGuardrailGitHubInstallations(state.connectionId)
      .then((next) => { if (current) setInstallations(next); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "Não foi possível listar instalações"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [state.connectionId]);

  useEffect(() => {
    if (!state.installationId) {
      setRepositories([]);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    void api.listGuardrailGitHubRepositories(state.installationId)
      .then((next) => { if (current) setRepositories(next); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : "Não foi possível listar repositórios autorizados"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [state.installationId]);

  useEffect(() => {
    if (!flowId) return;
    let current = true;
    const poll = window.setInterval(() => {
      void api.getGuardrailGitHubManifestFlow(flowId).then(({ flow }) => {
        if (!current) return;
        if (flow.status === "pending") {
          setFlowMessage("Aguardando a conclusão no GitHub…");
          return;
        }
        window.clearInterval(poll);
        setFlowId(null);
        if (flow.status === "completed") {
          setFlowMessage("GitHub App conectado. Atualizando a cadeia de autoridade…");
          void loadConnections(flow.connectionId);
        } else {
          setFlowMessage(`Conexão encerrada: ${flow.status}`);
        }
      }).catch((cause) => {
        if (!current) return;
        window.clearInterval(poll);
        setFlowId(null);
        setError(cause instanceof Error ? cause.message : "Falha ao acompanhar a conexão GitHub App");
      });
    }, 1_000);
    return () => {
      current = false;
      window.clearInterval(poll);
    };
  }, [flowId, loadConnections]);

  async function connectGitHub() {
    setLoading(true);
    setError(null);
    setFlowMessage("Abrindo o registro seguro no GitHub…");
    try {
      const flow = await api.startGuardrailGitHubManifest();
      setFlowId(flow.flowId);
      window.open(flow.authorizeUrl, "csb-github-app", "popup,width=760,height=820,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao iniciar GitHub App");
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit) void onEnroll(enrollmentRequest(state));
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-5 px-4 pb-6">
          <section aria-labelledby="enrollment-source-title">
            <StepHeading code="01 / REPOSITORY AUTHORITY" id="enrollment-source-title" title="Onde o código está?">
              A origem define quem resolve refs, política e evidência. Nenhum fallback troca uma pela outra.
            </StepHeading>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Origem do repositório">
              <ChoiceCard checked={state.source === "local"} icon={<HardDrive aria-hidden size={17} />} title="Pasta local" meta="FILESYSTEM" description="Usa um checkout Git existente neste computador." onSelect={() => setState((current) => selectEnrollmentSource(current, "local"))} />
              <ChoiceCard checked={state.source === "github"} icon={<GitBranch aria-hidden size={17} />} title="GitHub App" meta="REMOTE ONLY" description="Usa a instalação autorizada; nenhuma pasta local é necessária." onSelect={() => setState((current) => selectEnrollmentSource(current, "github"))} />
            </div>
          </section>

          {state.source === "local" ? (
            <section className="grid gap-4" aria-labelledby="local-repository-title">
              <StepHeading code="02 / LOCAL ROOT" id="local-repository-title" title="Fixe a raiz do checkout" />
              <RepositoryDirectoryBrowser active={active} value={state.repositoryPath} onChange={(repositoryPath) => setState((current) => ({ ...current, repositoryPath }))} />
              <Field label="Nome de exibição" htmlFor="guardrail-local-display-name" hint="Opcional; o nome da pasta será usado quando vazio.">
                <Input id="guardrail-local-display-name" className="min-h-11" value={state.displayName} onChange={(event) => setState((current) => ({ ...current, displayName: event.target.value }))} />
              </Field>
            </section>
          ) : (
            <section className="grid gap-4" aria-labelledby="github-authority-title">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                <StepHeading code="02 / GITHUB AUTHORITY CHAIN" id="github-authority-title" title="Conexão → instalação → repositório">
                  O servidor resolve owner, nome e branch. O browser envia apenas IDs estáveis.
                </StepHeading>
                <Button type="button" variant="outline" className="min-h-11" disabled={loading || flowId !== null} onClick={() => void connectGitHub()}><Plus aria-hidden size={14} />Conectar GitHub App</Button>
              </div>
              <div aria-live="polite" className="min-h-5 font-mono text-[9px] uppercase text-muted-foreground">{flowMessage ?? `${connections.length} conexão(ões) disponíveis`}</div>
              {error && <AlertBanner>{error}</AlertBanner>}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Conexão" htmlFor="guardrail-github-connection">
                  <Select value={state.connectionId} onValueChange={(value) => setState((current) => selectEnrollmentConnection(current, value))}>
                    <SelectTrigger id="guardrail-github-connection" className="min-h-11 w-full rounded-none"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent position="popper" className="rounded-none border-border bg-popover">{connections.filter((item) => item.status === "ready").map((item) => <SelectItem key={item.id} value={item.id} className="min-h-11 rounded-none">{item.appSlug}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label="Instalação" htmlFor="guardrail-github-installation">
                  <Select disabled={!state.connectionId} value={state.installationId} onValueChange={(value) => setState((current) => selectEnrollmentInstallation(current, value))}>
                    <SelectTrigger id="guardrail-github-installation" className="min-h-11 w-full rounded-none"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent position="popper" className="rounded-none border-border bg-popover">{installations.filter((item) => item.status === "ready").map((item) => <SelectItem key={item.id} value={item.id} className="min-h-11 rounded-none">{item.accountLogin}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label="Repositório" htmlFor="guardrail-github-repository">
                  <Select disabled={!state.installationId} value={state.repositoryId} onValueChange={(repositoryId) => setState((current) => ({ ...current, repositoryId }))}>
                    <SelectTrigger id="guardrail-github-repository" className="min-h-11 w-full rounded-none"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent position="popper" className="rounded-none border-border bg-popover">{repositories.map((item) => <SelectItem key={item.repositoryId} value={item.repositoryId} disabled={item.archived} className="min-h-11 rounded-none">{item.owner}/{item.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              </div>

              <div>
                <StepHeading code="03 / EXECUTION PLANE" title="Quem executa o gate?" />
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Executor padrão do gate">
                  <ChoiceCard checked={state.defaultExecutor === "sentinel-managed"} disabled={selectedRepository?.archived === true} icon={<Cloud aria-hidden size={17} />} title="Sentinel managed" meta="APP TOKEN" description="O Sentinel materializa um snapshot imutável e executa o scan localmente." onSelect={() => setState((current) => ({ ...current, defaultExecutor: "sentinel-managed" }))} />
                  <ChoiceCard checked={state.defaultExecutor === "github-actions"} disabled={selectedRepository?.archived === true} icon={<Workflow aria-hidden size={17} />} title="GitHub Actions" meta="CALLER PINNED" description="O repositório executa o caller fixado; a capacidade é verificada antes de cada dispatch." onSelect={() => setState((current) => ({ ...current, defaultExecutor: "github-actions" }))} />
                </div>
              </div>

              <div className="grid gap-3 border bg-secondary/20 p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                <span className="grid size-9 place-items-center border border-info text-info"><LockKeyhole aria-hidden size={16} /></span>
                <div className="min-w-0"><div className="bench-label text-info">SERVER-RESOLVED IDENTITY</div><p className="mt-1 text-xs leading-5 text-muted-foreground">{selectedRepository ? `${selectedRepository.owner}/${selectedRepository.name} · ${selectedRepository.private ? "PRIVATE" : "PUBLIC"} · ${selectedRepository.defaultBranch}` : "Selecione a cadeia completa para fixar a identidade remota."}</p></div>
              </div>
            </section>
          )}
        </div>
      </ScrollArea>

      <div className="sticky bottom-0 mt-auto grid gap-3 border-t bg-background/95 p-4 backdrop-blur sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-muted-foreground"><Radio aria-hidden size={14} className="mt-0.5 shrink-0 text-primary" /><span>{state.source === "local" ? "O gate lerá somente a raiz local selecionada." : "A autorização é limitada à instalação e ao repositório selecionados."}</span></div>
        <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy || loading || !canSubmit}><Plus aria-hidden size={14} />{busy ? "Cadastrando…" : state.source === "local" ? "Cadastrar pasta" : "Cadastrar repositório"}</Button>
      </div>
    </form>
  );
}

function StepHeading({ code, id, title, children }: { code: string; id?: string; title: string; children?: React.ReactNode }) {
  return <div className="mb-3"><div className="bench-label text-primary">{code}</div><h3 id={id} className="mt-1 font-heading text-base font-semibold">{title}</h3>{children && <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{children}</p>}</div>;
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label className="text-sm font-semibold" htmlFor={htmlFor}>{label}</label><div className="mt-2">{children}</div>{hint && <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}
