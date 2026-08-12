import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  Building2,
  Cloud,
  ExternalLink,
  GitBranch,
  HardDrive,
  LockKeyhole,
  Plus,
  Radio,
  RefreshCw,
  UserRound,
  Workflow,
} from "lucide-react";

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
import { useI18n } from "../../i18n";

export function RepositoryEnrollmentForm({ active, busy, onEnroll }: {
  active: boolean;
  busy: boolean;
  onEnroll: (request: EnrollGuardrailRepositoryRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState(initialEnrollmentState);
  const [connections, setConnections] = useState<GitHubAppConnection[]>([]);
  const [installations, setInstallations] = useState<GitHubAppInstallation[]>([]);
  const [repositories, setRepositories] = useState<GitHubInstallationRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [installationRefresh, setInstallationRefresh] = useState(0);

  const selectedConnection = connections.find((item) => item.id === state.connectionId) ?? null;
  const readyInstallations = installations.filter((item) => item.status === "ready");
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
      } else if (next.length === 1) {
        setState((current) => current.connectionId
          ? current
          : selectEnrollmentConnection(current, next[0]!.id));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("guardrails.connectionsError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      .then((next) => {
        if (!current) return;
        setInstallations(next);
        setState((value) => {
          if (value.connectionId !== state.connectionId) return value;
          const ready = next.filter((item) => item.status === "ready");
          if (value.installationId && ready.some((item) => item.id === value.installationId)) return value;
          return selectEnrollmentInstallation(value, ready.length === 1 ? ready[0]!.id : "");
        });
      })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : t("guardrails.installationsError")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [state.connectionId, installationRefresh, t]);

  useEffect(() => {
    if (!active || state.source !== "github" || !state.connectionId) return;
    const refreshAfterGitHub = () => setInstallationRefresh((value) => value + 1);
    window.addEventListener("focus", refreshAfterGitHub);
    return () => window.removeEventListener("focus", refreshAfterGitHub);
  }, [active, state.connectionId, state.source]);

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
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : t("guardrails.repositoriesError")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [state.installationId, t]);

  useEffect(() => {
    if (!flowId) return;
    let current = true;
    const poll = window.setInterval(() => {
      void api.getGuardrailGitHubManifestFlow(flowId).then(({ flow }) => {
        if (!current) return;
        if (flow.status === "pending") {
          setFlowMessage(t("guardrails.manifestWaiting"));
          return;
        }
        window.clearInterval(poll);
        setFlowId(null);
        if (flow.status === "completed") {
          setFlowMessage(t("guardrails.manifestConnected"));
          void loadConnections(flow.connectionId);
        } else {
          setFlowMessage(t("guardrails.manifestClosed", { status: flow.status }));
        }
      }).catch((cause) => {
        if (!current) return;
        window.clearInterval(poll);
        setFlowId(null);
        setError(cause instanceof Error ? cause.message : t("guardrails.manifestPollError"));
      });
    }, 1_000);
    return () => {
      current = false;
      window.clearInterval(poll);
    };
  }, [flowId, loadConnections, t]);

  async function connectGitHub() {
    setLoading(true);
    setError(null);
    setFlowMessage(t("guardrails.manifestOpening"));
    try {
      const flow = await api.startGuardrailGitHubManifest();
      setFlowId(flow.flowId);
      window.open(flow.authorizeUrl, "csb-github-app", "popup,width=760,height=820,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("guardrails.manifestStartError"));
    } finally {
      setLoading(false);
    }
  }

  function installGitHubApp() {
    if (!selectedConnection) return;
    setFlowMessage(t("guardrails.installationOpening"));
    window.open(
      selectedConnection.installationUrl,
      "csb-github-installation",
      "popup,width=900,height=900,noreferrer",
    );
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
            <StepHeading code="01 / REPOSITORY AUTHORITY" id="enrollment-source-title" title={t("guardrails.sourceTitle")}>
              {t("guardrails.sourceDescription")}
            </StepHeading>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("guardrails.sourceTitle")}>
              <ChoiceCard checked={state.source === "local"} icon={<HardDrive aria-hidden size={17} />} title={t("guardrails.localFolder")} meta="FILESYSTEM" description={t("guardrails.localFolderDescription")} onSelect={() => setState((current) => selectEnrollmentSource(current, "local"))} />
              <ChoiceCard checked={state.source === "github"} icon={<GitBranch aria-hidden size={17} />} title="GitHub App" meta="REMOTE ONLY" description={t("guardrails.githubAppDescription")} onSelect={() => setState((current) => selectEnrollmentSource(current, "github"))} />
            </div>
          </section>

          {state.source === "local" ? (
            <section className="grid gap-4" aria-labelledby="local-repository-title">
              <StepHeading code="02 / LOCAL ROOT" id="local-repository-title" title={t("guardrails.localRootTitle")} />
              <RepositoryDirectoryBrowser active={active} value={state.repositoryPath} onChange={(repositoryPath) => setState((current) => ({ ...current, repositoryPath }))} />
              <Field label={t("guardrails.displayName")} htmlFor="guardrail-local-display-name" hint={t("guardrails.displayNameHelp")}>
                <Input id="guardrail-local-display-name" className="min-h-11" value={state.displayName} onChange={(event) => setState((current) => ({ ...current, displayName: event.target.value }))} />
              </Field>
            </section>
          ) : (
            <section className="grid gap-4" aria-labelledby="github-authority-title">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                <StepHeading code="02 / GITHUB AUTHORITY CHAIN" id="github-authority-title" title={t("guardrails.githubChainTitle")}>
                  {t("guardrails.githubChainDescription")}
                </StepHeading>
                <Button type="button" variant="outline" className="min-h-11" disabled={loading || flowId !== null} onClick={() => void connectGitHub()}><Plus aria-hidden size={14} />{connections.length > 0 ? t("guardrails.createAnotherGitHubApp") : t("guardrails.connectGitHub")}</Button>
              </div>
              <div aria-live="polite" className="min-h-5 font-mono text-[9px] uppercase text-muted-foreground">{flowMessage ?? t("guardrails.connectionsAvailable", { count: connections.length })}</div>
              {error && <AlertBanner>{error}</AlertBanner>}

              {selectedConnection && (
                <div className="grid min-w-0 border bg-secondary/[.12]">
                  <div className="grid min-w-0 grid-cols-2 divide-x">
                    <AuthorityReadout label={t("guardrails.connectedApp")} value={selectedConnection.appSlug} detail={t("guardrails.connectionReady")} />
                    <AuthorityReadout label={t("guardrails.authorizedInstallations")} value={String(readyInstallations.length)} detail={readyInstallations.length === 1 ? t("guardrails.installationReady") : t("guardrails.installationsReady")} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t p-3">
                    <Button type="button" className="min-h-10 flex-1 rounded-none lg:flex-none" onClick={installGitHubApp}>
                      <ExternalLink aria-hidden size={14} />
                      {readyInstallations.length > 0 ? t("guardrails.installAnotherOrganization") : t("guardrails.installGitHubApp")}
                    </Button>
                    <Button type="button" variant="outline" className="min-h-10 flex-1 rounded-none lg:flex-none" disabled={loading} onClick={() => setInstallationRefresh((value) => value + 1)}>
                      <RefreshCw aria-hidden size={14} className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
                      {t("guardrails.refreshInstallations")}
                    </Button>
                  </div>
                </div>
              )}

              {selectedConnection && readyInstallations.length === 0 && !loading && (
                <div className="grid gap-3 border border-warning/50 bg-warning/[.06] p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                  <span className="grid size-9 place-items-center border border-warning/60 text-warning"><Building2 aria-hidden size={16} /></span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-warning">{t("guardrails.noInstallationsTitle")}</h4>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-warning/80">{t("guardrails.noInstallationsDescription")}</p>
                  </div>
                </div>
              )}

              {readyInstallations.length > 0 && (
                <div className="min-w-0">
                  <div className="bench-label mb-2 text-primary">{t("guardrails.installationAccounts")}</div>
                  <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto" role="list" aria-label={t("guardrails.installationAccounts")}>
                    {readyInstallations.map((installation) => {
                      const selected = installation.id === state.installationId;
                      return (
                        <button
                          key={installation.id}
                          type="button"
                          role="listitem"
                          aria-pressed={selected}
                          onClick={() => setState((current) => selectEnrollmentInstallation(current, installation.id))}
                          className={`flex min-h-10 min-w-0 items-center gap-2 border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${selected ? "border-info bg-info/[.08] text-foreground" : "border-border text-muted-foreground hover:border-info/50 hover:text-foreground"}`}
                        >
                          {installation.accountType === "Organization" ? <Building2 aria-hidden size={14} className="shrink-0 text-info" /> : <UserRound aria-hidden size={14} className="shrink-0 text-info" />}
                          <span className="min-w-0 truncate font-semibold">{installation.accountLogin}</span>
                          <span className="shrink-0 font-mono text-[8px] uppercase">{installation.accountType === "Organization" ? t("guardrails.organization") : t("guardrails.personalAccount")}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t("guardrails.connection")} htmlFor="guardrail-github-connection">
                  <Select value={state.connectionId} onValueChange={(value) => setState((current) => selectEnrollmentConnection(current, value))}>
                    <SelectTrigger id="guardrail-github-connection" className="min-h-11 w-full rounded-none"><SelectValue placeholder={t("guardrails.select")} /></SelectTrigger>
                    <SelectContent position="popper" className="rounded-none border-border bg-popover">{connections.filter((item) => item.status === "ready").map((item) => <SelectItem key={item.id} value={item.id} className="min-h-11 rounded-none">{item.appSlug}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label={t("guardrails.installation")} htmlFor="guardrail-github-installation">
                  <Select disabled={!state.connectionId} value={state.installationId} onValueChange={(value) => setState((current) => selectEnrollmentInstallation(current, value))}>
                    <SelectTrigger id="guardrail-github-installation" className="min-h-11 w-full rounded-none"><SelectValue placeholder={t("guardrails.select")} /></SelectTrigger>
                    <SelectContent position="popper" className="rounded-none border-border bg-popover">{installations.filter((item) => item.status === "ready").map((item) => <SelectItem key={item.id} value={item.id} className="min-h-11 rounded-none">{item.accountLogin}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label={t("guardrails.repository")} htmlFor="guardrail-github-repository">
                  <Select disabled={!state.installationId} value={state.repositoryId} onValueChange={(repositoryId) => setState((current) => ({ ...current, repositoryId }))}>
                    <SelectTrigger id="guardrail-github-repository" className="min-h-11 w-full rounded-none"><SelectValue placeholder={t("guardrails.select")} /></SelectTrigger>
                    <SelectContent position="popper" className="rounded-none border-border bg-popover">{repositories.map((item) => <SelectItem key={item.repositoryId} value={item.repositoryId} disabled={item.archived} className="min-h-11 rounded-none">{item.owner}/{item.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              </div>

              <div>
                <StepHeading code="03 / EXECUTION PLANE" title={t("guardrails.executionQuestion")} />
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("guardrails.executionQuestion")}>
                  <ChoiceCard checked={state.defaultExecutor === "sentinel-managed"} disabled={selectedRepository?.archived === true} icon={<Cloud aria-hidden size={17} />} title="Sentinel managed" meta="APP TOKEN" description={t("guardrails.managedEnrollmentDescription")} onSelect={() => setState((current) => ({ ...current, defaultExecutor: "sentinel-managed" }))} />
                  <ChoiceCard checked={state.defaultExecutor === "github-actions"} disabled={selectedRepository?.archived === true} icon={<Workflow aria-hidden size={17} />} title="GitHub Actions" meta="CALLER PINNED" description={t("guardrails.actionsEnrollmentDescription")} onSelect={() => setState((current) => ({ ...current, defaultExecutor: "github-actions" }))} />
                </div>
              </div>

              <div className="grid gap-3 border bg-secondary/20 p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                <span className="grid size-9 place-items-center border border-info text-info"><LockKeyhole aria-hidden size={16} /></span>
                <div className="min-w-0"><div className="bench-label text-info">SERVER-RESOLVED IDENTITY</div><p className="mt-1 text-xs leading-5 text-muted-foreground">{selectedRepository ? `${selectedRepository.owner}/${selectedRepository.name} · ${selectedRepository.private ? "PRIVATE" : "PUBLIC"} · ${selectedRepository.defaultBranch}` : t("guardrails.remoteIdentityPrompt")}</p></div>
              </div>
            </section>
          )}
        </div>
      </ScrollArea>

      <div className="sticky bottom-0 mt-auto grid gap-3 border-t bg-background/95 p-4 backdrop-blur sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-muted-foreground"><Radio aria-hidden size={14} className="mt-0.5 shrink-0 text-primary" /><span>{state.source === "local" ? t("guardrails.localScopeNotice") : t("guardrails.remoteScopeNotice")}</span></div>
        <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy || loading || !canSubmit}><Plus aria-hidden size={14} />{busy ? t("guardrails.registering") : state.source === "local" ? t("guardrails.registerFolder") : t("guardrails.registerRemote")}</Button>
      </div>
    </form>
  );
}

function AuthorityReadout({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 p-3 sm:p-4">
      <div className="min-h-5 font-mono text-[7px] uppercase leading-3 tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-sm font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function StepHeading({ code, id, title, children }: { code: string; id?: string; title: string; children?: React.ReactNode }) {
  return <div className="mb-3"><div className="bench-label text-primary">{code}</div><h3 id={id} className="mt-1 font-heading text-base font-semibold">{title}</h3>{children && <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{children}</p>}</div>;
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label className="text-sm font-semibold" htmlFor={htmlFor}>{label}</label><div className="mt-2">{children}</div>{hint && <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}
