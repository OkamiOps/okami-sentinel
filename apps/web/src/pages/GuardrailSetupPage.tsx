import { useCallback, useEffect, useState } from "react";
import type { GuardrailGitHubStatus, GuardrailRepository } from "@csb/shared";
import { ArrowLeft, GitBranch, HardDrive, RotateCw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { api, type GuardrailActionsStatus, type GuardrailCallerWorkflow } from "../api";
import type { GuardrailAutomationTriggers } from "../api";
import { GitHubStatusPanel } from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "../i18n";
import { githubPermissionRecovery, type GitHubPermissionRecovery } from "../lib/github-app-permission-recovery";

export function GuardrailSetupPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [repositories, setRepositories] = useState<GuardrailRepository[] | null>(null);
  const [status, setStatus] = useState<GuardrailGitHubStatus | null>(null);
  const [actionsStatus, setActionsStatus] = useState<GuardrailActionsStatus | null>(null);
  const [caller, setCaller] = useState<GuardrailCallerWorkflow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [permissionRecovery, setPermissionRecovery] = useState<GitHubPermissionRecovery | null>(null);
  const [workflowPermissionBlocked, setWorkflowPermissionBlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const requestedKey = params.get("repository");
  const selected = repositories?.find((repository) => repository.repositoryKey === requestedKey) ?? repositories?.[0] ?? null;

  const loadRepositories = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await api.listGuardrailRepositories();
      setRepositories(response.repositories);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("guardrails.repositoriesLoadError"));
    }
  }, [t]);

  const loadStatus = useCallback(async (repository: GuardrailRepository) => {
    setStatus(null);
    setActionsStatus(null);
    setCaller(null);
    setLoadError(null);
    setPermissionRecovery(null);
    setWorkflowPermissionBlocked(false);
    if (repository.source !== "github") return;
    try {
      const [remote, actions, connections] = await Promise.all([
        api.getGuardrailGitHubStatus(repository.repositoryKey),
        api.getGuardrailActionsStatus(repository.repositoryKey),
        api.listGuardrailGitHubConnections(),
      ]);
      setStatus(remote.status);
      setActionsStatus(actions.status);
      const connection = connections.find((item) => item.id === repository.githubConnectionId);
      if (connection && repository.githubInstallationId) {
        const installations = await api.listGuardrailGitHubInstallations(connection.id);
        const installation = installations.find((item) => item.id === repository.githubInstallationId);
        if (installation) setPermissionRecovery(githubPermissionRecovery(connection, installation));
      }
      try {
        setCaller((await api.getGuardrailCallerWorkflow(repository.repositoryKey)).workflow);
      } catch {
        setCaller(null);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("guardrails.capabilitiesLoadError"));
    }
  }, [t]);

  useEffect(() => { void loadRepositories(); }, [loadRepositories]);
  useEffect(() => {
    setBaselineError(null);
    setMessage(null);
    setWorkflowPermissionBlocked(false);
    if (selected) void loadStatus(selected);
  }, [selected?.repositoryKey, loadStatus]);

  async function syncBaseline() {
    if (!selected) return;
    setBusy(true);
    setBaselineError(null);
    setMessage(null);
    try {
      const response = await api.syncGuardrailBaseline(selected.repositoryKey);
      setMessage(response.baseline ? t("guardrails.baselineSynced", { sha: response.baseline.changeSet.headSha }) : t("guardrails.baselineMissing"));
      await loadStatus(selected);
    } catch (error) {
      setBaselineError(error instanceof Error ? error.message : t("guardrails.baselineSyncError"));
    } finally {
      setBusy(false);
    }
  }

  async function configureWorkflow(triggers: GuardrailAutomationTriggers) {
    if (!selected) return;
    setBusy(true);
    setLoadError(null);
    setMessage(null);
    try {
      const response = await api.installGuardrailCallerWorkflow(selected.repositoryKey, triggers);
      setActionsStatus(response.status);
      setMessage(t("guardrails.automationConfigured"));
      await loadStatus(selected);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setWorkflowPermissionBlocked(detail.includes("github_request_rejected") || detail.includes("github_credential_rejected"));
      setLoadError(`${t("guardrails.automationConfigureError")}${detail ? ` (${detail})` : ""}`);
    } finally {
      setBusy(false);
    }
  }

  if (repositories === null && !loadError) return <Loading />;

  return (
    <div className="min-w-0">
      <PageHeader code="03C / GITHUB SETUP" title={t("guardrails.githubTitle")} description={t("guardrails.githubDescription")} actions={<Button asChild variant="ghost" className="min-h-11"><Link to="/guardrails"><ArrowLeft aria-hidden size={14} />{t("guardrails.back")}</Link></Button>} />
      {message && <div aria-live="polite"><AlertBanner tone="success">{message}</AlertBanner></div>}
      {loadError && <div className="mb-4"><AlertBanner>{loadError}</AlertBanner><Button variant="outline" className="min-h-11" onClick={() => selected ? void loadStatus(selected) : void loadRepositories()}><RotateCw aria-hidden size={14} />{t("common.retry")}</Button></div>}

      {repositories?.length === 0 ? (
        <section className="bench-panel bench-corners"><EmptyState title={t("guardrails.noRegisteredRepositories")} description={t("guardrails.noRegisteredRepositoriesDescription")} /><div className="flex justify-center border-t p-4"><Button asChild className="min-h-11"><Link to="/guardrails"><GitBranch aria-hidden size={14} />{t("guardrails.openGuardrails")}</Link></Button></div></section>
      ) : selected ? (
        <>
          <section className="bench-panel mb-4 min-w-0" aria-labelledby="github-repository-title">
            <div className="grid items-end gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,.55fr)]">
              <div><div className="bench-label text-primary">{t("guardrails.targetRepository")}</div><h2 id="github-repository-title" className="mt-1 flex items-center gap-2 font-heading text-base font-semibold">{selected.source === "github" ? <GitBranch aria-hidden size={15} className="text-info" /> : <HardDrive aria-hidden size={15} className="text-primary" />}{selected.displayName}</h2><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{selected.source === "github" ? `${selected.remoteOwner}/${selected.remoteName}` : selected.repositoryPath}</p></div>
              <div><label className="text-sm font-semibold" htmlFor="github-repository-select">{t("guardrails.repository")}</label><Select value={selected.repositoryKey} onValueChange={(value) => { setParams({ repository: value }); setMessage(null); }}><SelectTrigger id="github-repository-select" className="mt-2 min-h-11 w-full rounded-none"><SelectValue /></SelectTrigger><SelectContent position="popper" className="rounded-none border-border bg-popover">{repositories?.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey} className="min-h-11 rounded-none">{repository.displayName}</SelectItem>)}</SelectContent></Select></div>
            </div>
          </section>
          {selected.source === "github" ? (
            status ? <GitHubStatusPanel repository={selected} status={status} actionsStatus={actionsStatus} callerWorkflow={caller} baselineError={baselineError} busy={busy} permissionRecovery={permissionRecovery} workflowPermissionBlocked={workflowPermissionBlocked} onRefresh={() => loadStatus(selected)} onConfigureWorkflow={configureWorkflow} onSyncBaseline={syncBaseline} /> : !loadError ? <Loading /> : null
          ) : (
            <section className="bench-panel bench-corners"><EmptyState title={t("guardrails.localExecutionTitle")} description={t("guardrails.localExecutionDescription")} /></section>
          )}
        </>
      ) : null}
    </div>
  );
}
