import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  GitBranch,
  HardDrive,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type {
  GuardrailRepository,
  ProviderConnection,
  ProviderModel,
} from "@csb/shared";

import { api, type EnrollGuardrailRepositoryRequest } from "../api";
import { GitHubBranchPicker } from "../components/guardrails/GitHubBranchPicker";
import { RepositoryEnrollmentForm } from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, Readout, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate, formatUsd, shortId } from "../format";
import { githubMonitorMessages } from "../i18n/github-monitor";
import { useScopedI18n } from "../i18n/scoped";
import { useI18n } from "../i18n";
import {
  githubMonitorApi,
  type GitHubCheckoutStatus,
} from "../lib/github-monitor-api";
import {
  branchesFromInput,
  draftFromGitHubMonitorRule,
  initialGitHubMonitorDraft,
  isValidFollowBranch,
  parseRequiredCeiling,
  ruleInputFromDraft,
  type GitHubMonitorDraft,
} from "../lib/github-monitor-state";

type CheckoutAction = "fetch" | "pull";

const eventTone: Record<string, string> = {
  observed: "border-border text-muted-foreground",
  queued: "border-chart-3/45 text-chart-3",
  dispatching: "border-primary/45 text-primary",
  launched: "border-chart-2/45 text-chart-2",
  skipped: "border-border text-muted-foreground",
  failed: "border-destructive/45 text-destructive",
};

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function GitHubMonitorPage() {
  const { t } = useScopedI18n(githubMonitorMessages);
  const { t: globalT } = useI18n();
  const [repositories, setRepositories] = useState<GuardrailRepository[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [selectedRepositoryKey, setSelectedRepositoryKey] = useState("");
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState("");
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof githubMonitorApi.overview>> | null>(null);
  const [checkout, setCheckout] = useState<GitHubCheckoutStatus | null>(null);
  const [checkoutReason, setCheckoutReason] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<"local" | "server" | null>(null);
  const [draft, setDraft] = useState<GitHubMonitorDraft>(() => initialGitHubMonitorDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<CheckoutAction | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const remoteRepositories = useMemo(
    () => repositories.filter((repository) => repository.source === "github" && repository.enabled),
    [repositories],
  );
  const localRepositories = useMemo(
    () => repositories.filter((repository) => repository.source === "local" && repository.enabled && repository.repositoryPath !== null),
    [repositories],
  );
  const selectedRepository = remoteRepositories.find((repository) => repository.repositoryKey === selectedRepositoryKey) ?? null;
  const selectedRule = overview?.rules.find((rule) => rule.repositoryKey === selectedRepositoryKey) ?? null;
  const readyConnections = connections.filter((connection) => connection.status === "ready");
  const selectedConnection = readyConnections.find((connection) => connection.id === draft.providerConnectionId) ?? null;
  const selectedModels = models.filter((model) => model.connectionId === selectedConnection?.id);
  const followedBranches = branchesFromInput(draft.followBranches);
  const branchesValid = followedBranches.length > 0 && followedBranches.length <= 20 && followedBranches.every(isValidFollowBranch);
  const budgetValid = parseRequiredCeiling(draft.costCeilingUsd) !== null &&
    (!draft.dailyCostCeilingUsd.trim() || parseRequiredCeiling(draft.dailyCostCeilingUsd) !== null);
  const routeReady = draft.executor === "github-actions"
    ? true
    : selectedConnection !== null &&
      (draft.modelSelectionMode === "runtime-default" || draft.modelId !== null);
  const canActivate = selectedRepository !== null && branchesValid && budgetValid && routeReady;
  const showBudgetValidation = selectedRule?.enabled === true;
  const currentEvents = overview?.events.filter((event) => event.repositoryKey === selectedRepositoryKey) ?? [];
  const currentActionRuns = overview?.actionsRuns.filter((run) => run.repositoryKey === selectedRepositoryKey) ?? [];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [repositoryResponse, nextConnections, nextOverview, session] = await Promise.all([
        api.listGuardrailRepositories(),
        api.listConnections(),
        githubMonitorApi.overview(),
        api.getSecuritySession(),
      ]);
      const nextRepositories = repositoryResponse.repositories;
      const nextRemote = nextRepositories.filter((repository) => repository.source === "github" && repository.enabled);
      setRepositories(nextRepositories);
      setConnections(nextConnections);
      setOverview(nextOverview);
      setRuntimeMode(session.runtimeMode);
      setSelectedRepositoryKey((current) => nextRemote.some((repository) => repository.repositoryKey === current)
        ? current
        : nextRemote[0]?.repositoryKey ?? "");
      const nextLocal = nextRepositories.filter((repository) => repository.source === "local" && repository.enabled && repository.repositoryPath !== null);
      setSelectedCheckoutKey((current) => nextLocal.some((repository) => repository.repositoryKey === current)
        ? current
        : nextLocal[0]?.repositoryKey ?? "");
      setError(null);
    } catch {
      setError(t("githubMonitor.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedRepository) return;
    const nextRule = overview?.rules.find((rule) => rule.repositoryKey === selectedRepository.repositoryKey) ?? null;
    setDraft(nextRule ? draftFromGitHubMonitorRule(nextRule) : initialGitHubMonitorDraft(selectedRepository.defaultBranch));
    setFormError(null);
  }, [overview?.rules, selectedRepository?.repositoryKey, selectedRepository?.defaultBranch]);

  useEffect(() => {
    let active = true;
    if (!selectedCheckoutKey) {
      setCheckout(null);
      setCheckoutReason(null);
      return () => { active = false; };
    }
    void githubMonitorApi.checkout(selectedCheckoutKey)
      .then((next) => {
        if (!active) return;
        setCheckout(next);
        setCheckoutReason(null);
      })
      .catch((cause) => {
        if (!active) return;
        setCheckout(null);
        setCheckoutReason(cause instanceof Error ? cause.message : "checkout_unavailable");
      });
    return () => { active = false; };
  }, [selectedCheckoutKey]);

  useEffect(() => {
    let active = true;
    if (draft.executor !== "sentinel-managed" || selectedConnection === null) {
      setModels([]);
      return () => { active = false; };
    }
    if (selectedConnection.modelSelectionMode === "runtime-default") {
      setModels([]);
      setDraft((current) => current.providerConnectionId !== selectedConnection.id
        ? current
        : { ...current, modelSelectionMode: "runtime-default", modelId: null });
      return () => { active = false; };
    }
    void api.listConnectionModels(selectedConnection.id)
      .then((next) => { if (active) setModels(next); })
      .catch(() => { if (active) setModels([]); });
    return () => { active = false; };
  }, [draft.executor, selectedConnection?.id, selectedConnection?.modelSelectionMode]);

  function chooseRepository(value: string) {
    setSelectedRepositoryKey(value);
  }

  function updateDraft(patch: Partial<GitHubMonitorDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(null);
  }

  async function save(enabled: boolean) {
    if (!selectedRepository) return;
    const body = ruleInputFromDraft(selectedRepository.repositoryKey, draft, enabled);
    if (!body || (enabled && !canActivate)) {
      setFormError(t("githubMonitor.invalidRule"));
      return;
    }
    setSaving(true);
    try {
      if (selectedRule) await githubMonitorApi.updateRule(selectedRule.id, body);
      else await githubMonitorApi.createRule(body);
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error && cause.message === "monitor_actions_duplicate_triggers"
        ? t("githubMonitor.actionsDuplicateError")
        : t("githubMonitor.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function deactivate() {
    if (!selectedRule) return;
    setSaving(true);
    try {
      await githubMonitorApi.updateRule(selectedRule.id, { enabled: false });
      await load();
    } catch {
      setFormError(t("githubMonitor.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function poll() {
    setPolling(true);
    try {
      setOverview(await githubMonitorApi.poll());
      setError(null);
    } catch {
      setError(t("githubMonitor.pollError"));
    } finally {
      setPolling(false);
    }
  }

  async function runCheckout(action: CheckoutAction) {
    if (!selectedCheckoutKey) return;
    setCheckoutBusy(action);
    try {
      setCheckout(await githubMonitorApi.checkoutSync(selectedCheckoutKey, action));
      setCheckoutReason(null);
    } catch {
      setCheckoutReason(t("githubMonitor.checkoutError"));
    } finally {
      setCheckoutBusy(null);
    }
  }

  async function enroll(request: EnrollGuardrailRepositoryRequest) {
    const response = await api.enrollGuardrailRepository(request);
    setEnrollmentOpen(false);
    await load();
    if (response.repository.source === "github") setSelectedRepositoryKey(response.repository.repositoryKey);
  }

  return <div>
    <PageHeader
      code="06 / GITHUB MONITOR"
      title={t("githubMonitor.title")}
      description={t("githubMonitor.description")}
      actions={<Button variant="outline" size="sm" disabled={polling || loading} onClick={() => void poll()}>
        <RefreshCw aria-hidden className={cx("size-3", polling && "animate-spin motion-reduce:animate-none")} />
        {polling ? t("githubMonitor.refreshing") : t("githubMonitor.refresh")}
      </Button>}
    />

    {error && <AlertBanner>{error}</AlertBanner>}
    {overview?.summary.lastError && <AlertBanner tone="warning">{t("githubMonitor.lastError", { error: overview.summary.lastError })}</AlertBanner>}

    {loading && !overview ? <Loading label={t("githubMonitor.loading")} /> : <>
      <section className="bench-panel bench-corners scanline overflow-hidden" aria-label={t("githubMonitor.title")}>
        <div className="grid grid-cols-2 lg:grid-cols-4">
          <SummaryCell label={t("githubMonitor.summary.rules")} value={overview?.summary.enabledRules ?? 0} tone={overview?.summary.enabledRules ? "good" : undefined} />
          <SummaryCell label={t("githubMonitor.summary.queue")} value={overview?.summary.queuedEvents ?? 0} tone={overview?.summary.queuedEvents ? "signal" : undefined} />
          <SummaryCell label={t("githubMonitor.summary.running")} value={overview?.summary.dispatchingEvents ?? 0} tone={overview?.summary.dispatchingEvents ? "signal" : undefined} />
          <SummaryCell label={t("githubMonitor.summary.lastPoll")} value={overview?.summary.lastPolledAt ? formatDate(overview.summary.lastPolledAt) : t("githubMonitor.notYet")} wrap />
        </div>
      </section>

      <Panel className="mt-4" label={t("githubMonitor.connection")} title={t("githubMonitor.connectionTitle")} aside={<Button type="button" size="sm" variant="configuration" onClick={() => setEnrollmentOpen((current) => !current)}><GitBranch aria-hidden className="size-3" />{t("githubMonitor.configureGithub")}</Button>}>
        <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("githubMonitor.connectionDescription")}</p>
        {enrollmentOpen && <div className="border-b"><RepositoryEnrollmentForm active={enrollmentOpen} busy={saving} onEnroll={enroll} /></div>}
        {remoteRepositories.length ? <div className="grid gap-3 p-4 lg:grid-cols-[minmax(14rem,.65fr)_minmax(0,1fr)] lg:items-end">
          <Field label={t("githubMonitor.repository")} htmlFor="github-monitor-repository">
            <Select value={selectedRepositoryKey} onValueChange={chooseRepository}>
              <SelectTrigger id="github-monitor-repository" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" className="rounded-none border-border bg-popover">
                {remoteRepositories.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey}>{repository.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {selectedRepository && <div className="min-w-0 border-l border-primary/35 pl-3"><div className="bench-label">GITHUB IDENTITY</div><div className="mt-1 flex min-w-0 items-center gap-2"><GitBranch aria-hidden className="size-3 shrink-0 text-primary" /><span className="truncate font-mono text-xs">{selectedRepository.remoteOwner}/{selectedRepository.remoteName}</span><span className="font-mono text-[9px] text-muted-foreground">· {selectedRepository.defaultBranch} {t("githubMonitor.defaultBranch")}</span></div></div>}
        </div> : <EmptyState title={t("githubMonitor.noRepositories")} description={t("githubMonitor.noRepositoriesDescription")} />}
      </Panel>

      {selectedRepository && <>
        <div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,.65fr)]">
          <Panel label={t("githubMonitor.rule")} title={t("githubMonitor.ruleTitle")} aside={<RuleState active={Boolean(selectedRule?.enabled)} activeLabel={t("githubMonitor.active")} inactiveLabel={t("githubMonitor.inactive")} />}>
            <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("githubMonitor.ruleDescription")}</p>
            <div className="grid gap-5 p-4">
              <section>
                <div className="bench-label text-primary">{t("githubMonitor.events")}</div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <EventSource label={t("githubMonitor.events.pr")} icon={<GitBranch aria-hidden className="size-4" />} />
                  <EventSource label={t("githubMonitor.events.push")} icon={<RotateCw aria-hidden className="size-4" />} />
                  <EventSource label={t("githubMonitor.events.actions")} icon={<Workflow aria-hidden className="size-4" />} />
                </div>
              </section>

              <Field label={t("githubMonitor.branches")} htmlFor="github-monitor-branches">
                <GitHubBranchPicker id="github-monitor-branches" repositoryKey={selectedRepositoryKey} value={followedBranches} onChange={(branches) => updateDraft({ followBranches: branches.join(", ") })} />
                {!branchesValid && <p role="alert" className="mt-2 text-xs text-destructive">{t("githubMonitor.branchesInvalid")}</p>}
              </Field>

              <section className="border-t pt-5">
                <div className="bench-label text-primary">{t("githubMonitor.execution")}</div>
                <h3 className="mt-1 text-sm font-semibold">{t("githubMonitor.executionTitle")}</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("githubMonitor.executionTitle")}>
                  <ExecutionChoice checked={draft.executor === "sentinel-managed"} icon={<ShieldCheck aria-hidden className="size-4" />} title="SENTINEL MANAGED" description={globalT("guardrails.managedDescription")} onSelect={() => updateDraft({ executor: "sentinel-managed" })} />
                  <ExecutionChoice checked={draft.executor === "github-actions"} icon={<Workflow aria-hidden className="size-4" />} title="GITHUB ACTIONS" description={globalT("guardrails.actionsDescription")} onSelect={() => updateDraft({ executor: "github-actions" })} />
                </div>
                {draft.executor === "github-actions" ? <div className="mt-3 border border-chart-3/40 bg-chart-3/[.06] p-3 text-xs leading-relaxed text-chart-3"><p>{globalT("guardrails.actionsDescription")}</p><p className="mt-2">{t("githubMonitor.actionsScheduling")}</p></div> : <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Field label={t("githubMonitor.engine")} htmlFor="github-monitor-engine" hint={t("githubMonitor.engineHint")}>
                    <Input id="github-monitor-engine" value="OpenAI Codex Security" readOnly aria-readonly="true" />
                  </Field>
                  <Field label={t("githubMonitor.connectionLabel")} htmlFor="github-monitor-connection">
                    <Select value={draft.providerConnectionId || undefined} onValueChange={(connectionId) => updateDraft({ providerConnectionId: connectionId, modelId: null, modelSelectionMode: "catalog" })}>
                      <SelectTrigger id="github-monitor-connection" className="w-full"><SelectValue placeholder={t("githubMonitor.connectionEmpty")} /></SelectTrigger>
                      <SelectContent position="popper" className="rounded-none border-border bg-popover">
                        {readyConnections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name} · {connection.display.routeLabel}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {!readyConnections.length && <p className="mt-2 text-xs text-destructive">{t("githubMonitor.connectionMissing")}</p>}
                  </Field>
                  <Field label={t("githubMonitor.model")} htmlFor="github-monitor-model">
                    {selectedConnection?.modelSelectionMode === "runtime-default" ? <Input id="github-monitor-model" value={t("githubMonitor.modelRuntime")} readOnly aria-readonly="true" /> : <Select value={draft.modelId ?? undefined} disabled={!selectedConnection} onValueChange={(modelId) => updateDraft({ modelId, modelSelectionMode: "catalog" })}>
                      <SelectTrigger id="github-monitor-model" className="w-full"><SelectValue placeholder={t("githubMonitor.modelEmpty")} /></SelectTrigger>
                      <SelectContent position="popper" className="rounded-none border-border bg-popover">
                        {selectedModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName}</SelectItem>)}
                      </SelectContent>
                    </Select>}
                  </Field>
                  <Field label={t("githubMonitor.mode")} htmlFor="github-monitor-mode">
                    <Select value={draft.mode} onValueChange={(mode) => updateDraft({ mode: mode as GitHubMonitorDraft["mode"] })}>
                      <SelectTrigger id="github-monitor-mode" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent position="popper" className="rounded-none border-border bg-popover"><SelectItem value="standard">{t("githubMonitor.mode.standard")}</SelectItem><SelectItem value="deep">{t("githubMonitor.mode.deep")}</SelectItem></SelectContent>
                    </Select>
                  </Field>
                </div>}
              </section>

              <section className="border-t pt-5">
                <div className="bench-label text-primary">{t("githubMonitor.budget")}</div>
                <h3 className="mt-1 text-sm font-semibold">{t("githubMonitor.budgetTitle")}</h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label={t("githubMonitor.perScan")} htmlFor="github-monitor-cost"><Input id="github-monitor-cost" type="number" min="0.01" step="0.01" inputMode="decimal" value={draft.costCeilingUsd} aria-invalid={showBudgetValidation && !budgetValid} onChange={(event) => updateDraft({ costCeilingUsd: event.target.value })} placeholder="2.00" /></Field>
                  <Field label={t("githubMonitor.perDay")} htmlFor="github-monitor-daily" hint={t("githubMonitor.perDayHint")}><Input id="github-monitor-daily" type="number" min="0.01" step="0.01" inputMode="decimal" value={draft.dailyCostCeilingUsd} aria-invalid={showBudgetValidation && !budgetValid} onChange={(event) => updateDraft({ dailyCostCeilingUsd: event.target.value })} placeholder={draft.costCeilingUsd || "10.00"} /></Field>
                </div>
                {showBudgetValidation && !budgetValid && <p role="alert" className="mt-2 text-xs text-destructive">{t("githubMonitor.budgetInvalid")}</p>}
              </section>
            </div>
          </Panel>

          <div className="grid content-start gap-4">
            <CheckoutPanel
              checkout={checkout}
              checkoutReason={checkoutReason}
              runtimeMode={runtimeMode}
              busy={checkoutBusy}
              localRepositories={localRepositories}
              selectedCheckoutKey={selectedCheckoutKey}
              t={t}
              onSelectCheckout={setSelectedCheckoutKey}
              onRun={(action) => void runCheckout(action)}
            />
            <Panel label={t("githubMonitor.automation")} title={selectedRule?.enabled ? t("githubMonitor.active") : t("githubMonitor.inactive")}>
              <div className="p-4">
                {formError && <AlertBanner>{formError}</AlertBanner>}
                <div className="grid gap-2">
                  {selectedRule?.enabled ? <>
                    <Button className="min-h-11 w-full" disabled={saving || !canActivate} onClick={() => void save(true)}>{saving ? t("githubMonitor.saving") : t("githubMonitor.update")}</Button>
                    <Button variant="outline" className="min-h-11 w-full" disabled={saving} onClick={() => void deactivate()}>{t("githubMonitor.deactivate")}</Button>
                  </> : <>
                    <Button variant="outline" className="min-h-11 w-full" disabled={saving || !branchesValid} onClick={() => void save(false)}>{saving ? t("githubMonitor.saving") : t("githubMonitor.follow")}</Button>
                    <Button className="min-h-11 w-full" disabled={saving || !canActivate} onClick={() => void save(true)}>{saving ? t("githubMonitor.saving") : t("githubMonitor.activate")}</Button>
                  </>}
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("githubMonitor.activationHint")}</p>
              </div>
            </Panel>
          </div>
        </div>

        <Panel className="mt-4" label={t("githubMonitor.activity")} title={t("githubMonitor.activityTitle")} wrapTitle>
          <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("githubMonitor.activityDescription")}</p>
          {currentEvents.length || currentActionRuns.length ? <div className="divide-y">
            {currentEvents.map((event) => <MonitorEventRow key={event.id} event={event} t={t} />)}
            {currentActionRuns.map((run) => <ActionsRunRow key={run.id} run={run} t={t} />)}
          </div> : <EmptyState title={t("githubMonitor.noEvents")} description={t("githubMonitor.noEventsDescription")} />}
        </Panel>
      </>}
    </>}
  </div>;
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label className="text-xs font-semibold" htmlFor={htmlFor}>{label}</label><div className="mt-2">{children}</div>{hint && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}</div>;
}

function SummaryCell({ label, value, tone, wrap = false }: { label: string; value: string | number; tone?: "signal" | "risk" | "good"; wrap?: boolean }) {
  return <div className="min-w-0 border-b p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><Readout label={label} value={value} tone={tone} wrap={wrap} /></div>;
}

function RuleState({ active, activeLabel, inactiveLabel }: { active: boolean; activeLabel: string; inactiveLabel: string }) {
  return <span className={cx("inline-flex h-6 items-center gap-1.5 border px-2 font-mono text-[9px] uppercase tracking-wider", active ? "border-chart-2/45 text-chart-2" : "border-border text-muted-foreground")}><span className="size-1.5 rounded-full bg-current" />{active ? activeLabel : inactiveLabel}</span>;
}

function EventSource({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <div className="flex min-w-0 items-center gap-3 border bg-secondary/[.16] p-3"><span className="grid size-7 shrink-0 place-items-center border border-primary/45 text-primary"><Check aria-hidden className="size-3" /></span><span className="min-w-0 text-xs"><span className="mr-2 inline-block align-middle text-primary">{icon}</span>{label}</span></div>;
}

function ExecutionChoice({ checked, icon, title, description, onSelect }: { checked: boolean; icon: React.ReactNode; title: string; description: string; onSelect: () => void }) {
  return <button type="button" role="radio" aria-checked={checked} onClick={onSelect} className={cx("min-h-28 border p-4 text-left transition-colors focus-visible:outline-none", checked ? "border-primary bg-primary/[.08]" : "border-border bg-card/30 hover:bg-secondary/40")}><span className={cx("grid size-8 place-items-center border", checked ? "border-primary text-primary" : "border-border text-muted-foreground")}>{icon}</span><strong className="mt-3 block font-mono text-[10px] tracking-[.08em]">{title}</strong><span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{description}</span></button>;
}

function CheckoutPanel({ checkout, checkoutReason, runtimeMode, busy, localRepositories, selectedCheckoutKey, t, onSelectCheckout, onRun }: {
  checkout: GitHubCheckoutStatus | null;
  checkoutReason: string | null;
  runtimeMode: "local" | "server" | null;
  busy: CheckoutAction | null;
  localRepositories: GuardrailRepository[];
  selectedCheckoutKey: string;
  t: (key: keyof typeof githubMonitorMessages["pt-BR"], variables?: Record<string, string | number>) => string;
  onSelectCheckout: (repositoryKey: string) => void;
  onRun: (action: CheckoutAction) => void;
}) {
  const serverReadOnly = runtimeMode === "server" || checkout?.writable === false;
  const unavailable = checkout === null && checkoutReason !== null;
  return <Panel label={t("githubMonitor.checkout")} title={t("githubMonitor.checkoutTitle")}>
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("githubMonitor.checkoutDescription")}</p>
    {localRepositories.length ? <div className="p-4"><Field label={t("githubMonitor.repository")} htmlFor="github-monitor-checkout-repository"><Select value={selectedCheckoutKey} onValueChange={onSelectCheckout}><SelectTrigger id="github-monitor-checkout-repository" className="w-full"><SelectValue /></SelectTrigger><SelectContent position="popper" className="rounded-none border-border bg-popover">{localRepositories.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey}>{repository.displayName}</SelectItem>)}</SelectContent></Select></Field></div> : <EmptyState title={t("githubMonitor.checkout.unavailable")} />}
    {serverReadOnly && <div className="mx-4 mb-4"><AlertBanner tone="warning">{t("githubMonitor.checkout.server")}</AlertBanner></div>}
    {unavailable && <div className="mx-4 mb-4"><AlertBanner tone="info">{t("githubMonitor.checkout.unavailable")}</AlertBanner></div>}
    {checkout && <div className="border-t">
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4"><CheckoutReadout label={t("githubMonitor.checkout.branch")} value={checkout.branch ?? "—"} /><CheckoutReadout label={t("githubMonitor.checkout.head")} value={checkout.head ? shortId(checkout.head) : "—"} /><CheckoutReadout label="WORKTREE" value={checkout.dirty ? t("githubMonitor.checkout.dirty") : t("githubMonitor.checkout.clean")} tone={checkout.dirty ? "risk" : "good"} /><CheckoutReadout label="SYNC" value={checkout.behind === null ? "—" : `${t("githubMonitor.checkout.behind", { count: checkout.behind })} · ${t("githubMonitor.checkout.ahead", { count: checkout.ahead ?? 0 })}`} /></div>
      <div className="flex flex-wrap gap-2 border-t p-4">
        <Button variant="outline" size="sm" disabled={!checkout.canFetch || busy !== null} onClick={() => onRun("fetch")}><RotateCw aria-hidden className={cx("size-3", busy === "fetch" && "animate-spin")} />{busy === "fetch" ? t("githubMonitor.checkoutBusy") : t("githubMonitor.fetch")}</Button>
        <Button variant="outline" size="sm" disabled={!checkout.canPull || busy !== null} onClick={() => onRun("pull")}><HardDrive aria-hidden className="size-3" />{busy === "pull" ? t("githubMonitor.checkoutBusy") : t("githubMonitor.pull")}</Button>
      </div>
    </div>}
  </Panel>;
}

function CheckoutReadout({ label, value, tone }: { label: string; value: string; tone?: "risk" | "good" }) {
  return <div className="min-w-0 bg-card px-3 py-3"><div className="bench-label">{label}</div><div className={cx("mt-1 truncate font-mono text-[10px]", tone === "good" && "text-chart-2", tone === "risk" && "text-destructive")}>{value}</div></div>;
}

function MonitorEventRow({ event, t }: { event: Awaited<ReturnType<typeof githubMonitorApi.overview>>["events"][number]; t: (key: keyof typeof githubMonitorMessages["pt-BR"], variables?: Record<string, string | number>) => string }) {
  const gateUrl = event.gateId ? `/guardrails/${encodeURIComponent(event.gateId)}` : null;
  const reason = event.error ?? event.reason;
  const isBaseline = !event.error && reason === "initial_baseline";
  return <article className="grid min-w-0 gap-3 px-4 py-4 lg:grid-cols-[9rem_minmax(0,1fr)_auto] lg:items-center"><div><span className={cx("inline-flex border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", eventTone[event.status] ?? "border-border text-muted-foreground")}>{event.status === "observed" ? t("githubMonitor.notYet") : event.status === "dispatching" ? t("githubMonitor.refreshing") : t(`githubMonitor.event.${event.status}`)}</span><div className="mt-2 font-mono text-[9px] text-muted-foreground">{formatDate(event.detectedAt)}</div></div><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><GitBranch aria-hidden className="size-3 shrink-0 text-primary" /><strong className="truncate text-sm">{event.kind === "pull_request" ? t("githubMonitor.event.pr_updated") : t("githubMonitor.event.push")}{event.pullRequestNumber ? ` #${event.pullRequestNumber}` : ""}</strong></div><div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{event.headRef || t("githubMonitor.unknownRef")} · {shortId(event.headSha)}</div>{event.title && <p className="mt-1 truncate text-xs text-muted-foreground">{event.title}</p>}{reason && <p className={cx("mt-2 text-xs", isBaseline ? "text-muted-foreground" : "text-destructive")}>{isBaseline ? t("githubMonitor.baseline") : reason}</p>}</div><div className="flex items-center gap-2">{event.costCeilingUsd !== null && <span className="font-mono text-[10px] text-primary">{formatUsd(event.costCeilingUsd, true)}</span>}{gateUrl && <Button asChild variant="outline" size="sm"><Link to={gateUrl}>{t("githubMonitor.openGate")}<ArrowUpRight aria-hidden className="size-3" /></Link></Button>}</div></article>;
}

function ActionsRunRow({ run, t }: { run: Awaited<ReturnType<typeof githubMonitorApi.overview>>["actionsRuns"][number]; t: (key: keyof typeof githubMonitorMessages["pt-BR"], variables?: Record<string, string | number>) => string }) {
  const url = safeExternalUrl(run.url);
  return <article className="grid min-w-0 gap-3 bg-secondary/[.12] px-4 py-4 lg:grid-cols-[9rem_minmax(0,1fr)_auto] lg:items-center"><div><span className="inline-flex border border-chart-5/45 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-chart-5">{t("githubMonitor.event.actions_run")}</span><div className="mt-2 font-mono text-[9px] text-muted-foreground">{formatDate(run.updatedAt)}</div></div><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><Workflow aria-hidden className="size-3 shrink-0 text-chart-5" /><strong className="truncate text-sm">{run.name}</strong></div><div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{run.event} · {run.headBranch ?? t("githubMonitor.unknownRef")} · {shortId(run.headSha)}</div><p className="mt-1 text-xs text-muted-foreground">{run.status}{run.conclusion ? ` · ${run.conclusion}` : ""}</p></div>{url && <Button asChild variant="outline" size="sm"><a href={url} target="_blank" rel="noreferrer">{t("githubMonitor.openActions")}<ArrowUpRight aria-hidden className="size-3" /></a></Button>}</article>;
}
