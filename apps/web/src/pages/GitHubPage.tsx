import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type {
  GitHubAction,
  GitHubActionEvent,
  GitHubActionEventStatus,
  GuardrailRepository,
  ProviderConnection,
  ProviderModel,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { api } from "../api";
import { useAuth } from "../auth/AuthProvider";
import {
  ActionList,
  ActionSheet,
  ActivityList,
  IntegrationPanel,
  type GitHubT,
} from "../components/github";
import { AlertBanner, Loading, PageHeader, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { githubActionsMessages, type GitHubActionsMessageKey } from "../i18n/github-actions";
import { useScopedI18n } from "../i18n/scoped";
import type { GitHubActionRequestBody } from "../lib/github-action-form";
import { githubActionsApi, type GitHubIntegrationStatus } from "../lib/github-actions-api";
import { ApiError } from "../lib/http";
import { loadLiveConnectionModels } from "../lib/new-scan-routing";

type Section = "integration" | "actions" | "activity";

const ACTIVITY_PAGE = 50;

/**
 * The GitHub tab: `01 INTEGRAÇÃO` (administrator only), `02 AÇÕES` and
 * `03 ATIVIDADE`. The section lives in the URL so a link, a reload and a screenshot
 * all land on the same place.
 */
export function GitHubPage() {
  const { t } = useScopedI18n(githubActionsMessages);
  const { isAdmin, can, canAny } = useAuth();
  const [params, setParams] = useSearchParams();

  const [repositories, setRepositories] = useState<GuardrailRepository[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [integration, setIntegration] = useState<GitHubIntegrationStatus | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[] | null>(null);
  const [actions, setActions] = useState<GitHubAction[]>([]);
  const [events, setEvents] = useState<GitHubActionEvent[]>([]);
  const [eventsHasMore, setEventsHasMore] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<GitHubAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretNotice, setSecretNotice] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNotice, setReconcileNotice] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  const sections = useMemo<ReadonlyArray<{ id: Section; code: string; label: string }>>(() => [
    ...(isAdmin ? [{ id: "integration" as const, code: "01", label: t("github.section.integration") }] : []),
    { id: "actions", code: "02", label: t("github.section.actions") },
    { id: "activity", code: "03", label: t("github.section.activity") },
  ], [isAdmin, t]);
  const requested = params.get("section");
  const section: Section = sections.some((item) => item.id === requested)
    ? requested as Section
    : sections[0]!.id;

  const repositoryKey = params.get("repository") ?? "";
  const outcome = (params.get("outcome") ?? "") as GitHubActionEventStatus | "";

  const setParam = useCallback((key: string, value: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === "") next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setParams]);

  /**
   * One read per visit, and one per press of Refresh. The integration status calls
   * GitHub twice per connection, so an interval would spend those calls on a screen
   * nobody is looking at.
   */
  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    const [repositoryResult, connectionResult, actionResult, eventResult, integrationResult, deliveryResult] =
      await Promise.allSettled([
        api.listGuardrailRepositories(),
        isAdmin ? api.listConnections() : Promise.resolve([]),
        githubActionsApi.fetchActions(repositoryKey || null),
        githubActionsApi.fetchEvents({
          repositoryKey: repositoryKey || null,
          outcome: outcome || null,
          limit: ACTIVITY_PAGE,
        }),
        isAdmin ? githubActionsApi.fetchIntegration() : Promise.resolve(null),
        isAdmin ? githubActionsApi.fetchDeliveries(50) : Promise.resolve(null),
      ]);

    if (repositoryResult.status === "fulfilled") setRepositories(repositoryResult.value.repositories);
    if (connectionResult.status === "fulfilled") setConnections(connectionResult.value);
    if (actionResult.status === "fulfilled") setActions(actionResult.value.actions);
    if (eventResult.status === "fulfilled") {
      setEvents(eventResult.value.events);
      setEventsHasMore(eventResult.value.hasMore);
    }
    // A 502 from the integration read is GitHub's outage, not the tab's: the actions
    // and the activity are still readable and still worth showing.
    if (integrationResult.status === "fulfilled") setIntegration(integrationResult.value);
    else setIntegration(null);
    if (deliveryResult.status === "fulfilled") setDeliveries(deliveryResult.value?.deliveries ?? null);

    const failed = [repositoryResult, actionResult, eventResult].some((result) => result.status === "rejected");
    setLoadError(failed ? t("github.loadError") : null);
    setLoading(false);
    setRefreshing(false);
  }, [isAdmin, repositoryKey, outcome, t]);

  useEffect(() => { void load("initial"); }, [load]);

  // The models of the connection the sheet has selected, loaded only while it is
  // open: a catalogue read per row of the table would be a remote call per render.
  const loadModels = useCallback((connectionId: string | null) => {
    if (connectionId === null) {
      setModels([]);
      return;
    }
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (connection === undefined || connection.modelSelectionMode === "runtime-default") {
      setModels([]);
      return;
    }
    void loadLiveConnectionModels(api, connectionId)
      .then(setModels)
      .catch(() => setModels([]));
  }, [connections]);

  const enrolledRepositories = useMemo(
    () => repositories.filter((repository) => repository.enabled),
    [repositories],
  );

  function openCreate() {
    setEditing(null);
    setSubmitError(null);
    setSheetOpen(true);
    loadModels(null);
  }

  function openEdit(action: GitHubAction) {
    setEditing(action);
    setSubmitError(null);
    setSheetOpen(true);
    loadModels(action.scanner?.connection.connectionId ?? null);
  }

  async function submit(body: GitHubActionRequestBody) {
    setSaving(true);
    setSubmitError(null);
    try {
      if (editing === null) await githubActionsApi.createAction(body);
      else {
        await githubActionsApi.patchAction(editing.id, {
          name: body.name,
          triggerKind: body.triggerKind,
          branchPatterns: body.branchPatterns,
          ...(isAdmin
            ? {
              executor: body.executor,
              scanner: body.scanner,
              costCeilingUsd: body.costCeilingUsd,
              dailyCostCeilingUsd: body.dailyCostCeilingUsd,
              enabled: body.enabled,
              includeForks: body.includeForks,
            }
            : {}),
        });
      }
      setSheetOpen(false);
      await load("refresh");
    } catch (error) {
      setSubmitError(writeErrorMessage(error, t));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(action: GitHubAction, enabled: boolean) {
    setBusyActionId(action.id);
    setActionError(null);
    try {
      await githubActionsApi.patchAction(action.id, { enabled });
      await load("refresh");
    } catch (error) {
      setActionError(writeErrorMessage(error, t));
    } finally {
      setBusyActionId(null);
    }
  }

  async function remove(action: GitHubAction) {
    if (!window.confirm(t("github.actions.deleteConfirm", { name: action.name }))) return;
    setBusyActionId(action.id);
    setActionError(null);
    try {
      await githubActionsApi.deleteAction(action.id);
      await load("refresh");
    } catch (error) {
      setActionError(writeErrorMessage(error, t, "github.error.deleteFailed"));
    } finally {
      setBusyActionId(null);
    }
  }

  async function saveSecret(connectionId: string, secret: string) {
    setSavingSecret(true);
    setSecretNotice(null);
    setSecretError(null);
    try {
      await githubActionsApi.saveWebhookSecret(connectionId, secret);
      setSecretNotice(t("github.webhook.saved"));
      await load("refresh");
    } catch (error) {
      setSecretError(secretErrorMessage(error, t));
    } finally {
      setSavingSecret(false);
    }
  }

  async function reconcile() {
    setReconciling(true);
    setReconcileNotice(null);
    setReconcileError(null);
    try {
      const result = await githubActionsApi.reconcileNow();
      // A joined cycle's counts predate the press, and the operator has to be told.
      setReconcileNotice(t(result.joined ? "github.reconcile.joined" : "github.reconcile.done", {
        repositories: result.repositories,
        created: result.created,
        observed: result.observed,
      }));
      await load("refresh");
    } catch {
      setReconcileError(t("github.reconcile.error"));
    } finally {
      setReconciling(false);
    }
  }

  async function loadMoreEvents() {
    setActivityLoading(true);
    try {
      const page = await githubActionsApi.fetchEvents({
        repositoryKey: repositoryKey || null,
        outcome: outcome || null,
        limit: ACTIVITY_PAGE,
        offset: events.length,
      });
      setEvents((current) => [...current, ...page.events]);
      setEventsHasMore(page.hasMore);
    } catch {
      setLoadError(t("github.loadError"));
    } finally {
      setActivityLoading(false);
    }
  }

  const sheetRepositoryKey = editing?.repositoryKey ?? repositoryKey;

  return <div className="min-w-0">
    {/* Tab bar first, then the header — the order every section screen uses. */}
    <nav aria-label={t("github.title")} className="mb-4 grid w-full grid-cols-3 gap-px overflow-hidden border border-border bg-border lg:flex">
      {sections.map((item) => {
        const active = item.id === section;
        return <button
          key={item.id}
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={() => setParam("section", item.id)}
          className={cx(
            "group relative flex h-10 min-w-0 items-center justify-center gap-2 bg-background px-3 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring lg:shrink-0 lg:justify-start lg:px-4",
            active && "bg-accent text-chart-1",
          )}
        >
          <span className="text-[8px] opacity-55">{item.code}</span>
          <span className="truncate">{item.label}</span>
          <span className={cx("absolute inset-x-0 bottom-0 h-px bg-chart-1 transition-transform", active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} />
        </button>;
      })}
      {/* The tabs sit on a border-coloured track separated by a one-pixel gap,
          which is what draws the hairlines. A member sees two tabs, not three, so
          the empty cell of the grid would expose the track as a solid block —
          the same filler the Settings tabs use. */}
      {Array.from({ length: (3 - (sections.length % 3)) % 3 }, (_, index) => (
        <span key={`filler-${index}`} aria-hidden="true" className="h-10 bg-background lg:hidden" />
      ))}
      <span aria-hidden="true" className="hidden bg-background lg:block lg:flex-1" />
    </nav>

    <PageHeader
      code={t("github.moduleCode")}
      title={t("github.title")}
      description={t("github.description")}
      actions={<Button variant="outline" size="sm" disabled={loading || refreshing} onClick={() => void load("refresh")}>
        <RefreshCw aria-hidden className={cx("size-3", refreshing && "animate-spin motion-reduce:animate-none")} />
        {refreshing ? t("github.refreshing") : t("github.refresh")}
      </Button>}
    />

    {loadError && <AlertBanner>{loadError}</AlertBanner>}
    {isAdmin && section === "integration" && integration === null && !loading
      && <AlertBanner tone="warning">{t("github.integration.unavailable")}</AlertBanner>}

    {loading
      ? <Loading label={t("github.loading")} />
      : <>
        {section === "integration" && isAdmin && <IntegrationPanel
          status={integration}
          t={t}
          canEdit={isAdmin}
          busySecret={savingSecret}
          secretNotice={secretNotice}
          secretError={secretError}
          reconciling={reconciling}
          reconcileNotice={reconcileNotice}
          reconcileError={reconcileError}
          deliveries={deliveries}
          onSaveSecret={(connectionId, secret) => void saveSecret(connectionId, secret)}
          onReconcile={() => void reconcile()}
        />}

        {section === "actions" && <>
          <ActionList
            actions={actions}
            repositories={enrolledRepositories}
            repositoryKey={repositoryKey}
            t={t}
            isAdmin={isAdmin}
            can={can}
            busyActionId={busyActionId}
            error={actionError}
            onRepositoryChange={(value) => setParam("repository", value)}
            onCreate={openCreate}
            onEdit={openEdit}
            onToggle={(action, enabled) => void toggle(action, enabled)}
            onDelete={(action) => void remove(action)}
          />
          {(isAdmin || canAny("maintainer")) && <ActionSheet
            open={sheetOpen}
            action={editing}
            repositoryKey={sheetRepositoryKey}
            connections={connections}
            models={models}
            isAdmin={isAdmin}
            saving={saving}
            submitError={submitError}
            t={t}
            onOpenChange={setSheetOpen}
            onSubmit={(body) => void submit(body)}
            onConnectionChange={loadModels}
          />}
        </>}

        {section === "activity" && <ActivityList
          events={events}
          repositories={enrolledRepositories}
          repositoryKey={repositoryKey}
          outcome={outcome}
          hasMore={eventsHasMore}
          loading={activityLoading}
          t={t}
          onRepositoryChange={(value) => setParam("repository", value)}
          onOutcomeChange={(value) => setParam("outcome", value)}
          onLoadMore={() => void loadMoreEvents()}
        />}
      </>}
  </div>;
}

/**
 * Both 409 code pairs for "this repository cannot be automated" map to one message:
 * `POST /github/actions` answers `repository_source_unsupported` and
 * `GET /github/branches` answers `github_repository_unsupported` for the same fact,
 * and the operator does not care which route noticed.
 */
function writeErrorMessage(
  error: unknown,
  t: GitHubT,
  fallback: GitHubActionsMessageKey = "github.error.saveFailed",
): string {
  if (!(error instanceof ApiError)) return t(fallback);
  switch (error.message) {
    case "github_action_name_taken":
      return t("github.error.nameTaken");
    case "github_action_branch_patterns_unreviewed":
      return t("github.error.patternsUnreviewed");
    case "repository_source_unsupported":
    case "github_repository_unsupported":
      return t("github.error.repositoryUnsupported");
    case "invalid_branch_patterns":
      return t("github.error.branchPatterns.invalid");
    case "invalid_cost_ceiling":
      return t("github.error.costCeilingUsd.not_positive");
    case "forbidden":
      return t("github.error.forbidden");
    case "not_found":
    case "repository_not_found":
      return t("github.error.notFound");
    default:
      return t(fallback);
  }
}

function secretErrorMessage(error: unknown, t: GitHubT): string {
  if (!(error instanceof ApiError)) return t("github.webhook.secretError");
  if (error.message === "webhook_secret_invalid") return t("github.webhook.secretInvalid");
  if (error.message === "connection_not_found") return t("github.webhook.connectionNotFound");
  return t("github.webhook.secretError");
}
