import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Beaker, FileCheck2, GitBranch, Save, ShieldAlert, Workflow } from "lucide-react";
import type {
  GateRun,
  GuardrailBaseline,
  GuardrailPolicy,
  GuardrailRepositoryListRow,
  GuardrailRule,
} from "@csb/shared";

import {
  api,
  type GuardrailPolicyResponse,
  type PolicySimulationResponse,
} from "../api";
import { useAuth } from "../auth/AuthProvider";
import {
  BaselineCard,
  GateOutcomeBadge,
  PolicyDiffPreview,
  PolicyPresetPicker,
  PolicyRuleEditor,
} from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUsd } from "../format";
import { formatApiError } from "../lib/http";
import {
  editorStateFromPolicy,
  isProtectedBranchBaselineRun,
  policyFromEditor,
  validatePolicyEditor,
  type PolicyEditorState,
} from "../lib/guardrails";
import {
  policySourceLabelKey,
  selectedPresetFromPolicy,
} from "../lib/guardrail-repository-page";
import { useI18n } from "../i18n";

interface RepositoryPageData {
  repository: GuardrailRepositoryListRow;
  policy: GuardrailPolicyResponse;
  baseline: GuardrailBaseline;
  hasProtectedBranchAction: boolean;
  gates: GateRun[];
}

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: RepositoryPageData };

/**
 * One page per repository: the policy with its preset and simulation, the baseline,
 * the pull-request comment, the gate history, and the way to this repository's
 * actions in the GitHub tab.
 *
 * It replaces the policy-only page, which is why `/policy` redirects here.
 */
export function GuardrailRepositoryPage() {
  const { t, locale } = useI18n();
  const { isAdmin, can } = useAuth();
  const { repositoryKey = "" } = useParams();

  const [state, setState] = useState<PageState>({ status: "loading" });
  const [editor, setEditor] = useState<PolicyEditorState | null>(null);
  const [gateId, setGateId] = useState("");
  const [simulation, setSimulation] = useState<PolicySimulationResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [baselineBusy, setBaselineBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [repositories, policy, baseline, gates] = await Promise.all([
        api.listGuardrailRepositories(),
        api.getGuardrailPolicy(repositoryKey),
        api.getGuardrailBaseline(repositoryKey),
        api.listGates(repositoryKey),
      ]);
      const repository = repositories.repositories.find((row) => row.repositoryKey === repositoryKey);
      if (!repository) throw new Error(t("guardrails.repositoryNotFound"));
      setState({
        status: "ready",
        data: {
          repository,
          policy,
          baseline: baseline.baseline,
          hasProtectedBranchAction: baseline.hasProtectedBranchAction,
          gates: gates.gates,
        },
      });
      setEditor(editorStateFromPolicy(policy.policy));
      const eligible = gates.gates.filter((gate) => gate.artifactPath !== null);
      setGateId((current) => eligible.some((gate) => gate.id === current) ? current : eligible[0]?.id ?? "");
    } catch (error) {
      setState({ status: "error", message: formatApiError(error, t) });
    }
  }, [repositoryKey, t]);

  useEffect(() => { void load(); }, [load]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return <div>
      <AlertBanner>{state.message}</AlertBanner>
      <Button asChild variant="outline" size="sm">
        <Link to="/guardrails"><ArrowLeft aria-hidden className="size-3" />{t("guardrails.repositoryBack")}</Link>
      </Button>
    </div>;
  }
  if (editor === null) return <Loading />;

  const { repository, policy, baseline, hasProtectedBranchAction, gates } = state.data;
  const proposed = policyFromEditor(editor);
  const validation = validatePolicyEditor(editor);
  const changed = JSON.stringify(policy.policy) !== JSON.stringify(proposed);
  const eligibleGates = gates.filter((gate) => gate.artifactPath !== null);
  // The repository's own file outranks everybody; below that, writing is a
  // maintainer's and the API re-decides it either way.
  const readOnly = policy.readOnly || !can("maintainer", repositoryKey);
  const preset = selectedPresetFromPolicy(proposed);

  function update<K extends keyof PolicyEditorState>(key: K, value: PolicyEditorState[K]) {
    setEditor((current) => current === null ? current : { ...current, [key]: value });
    setNotice(null);
    setSimulation(null);
  }

  async function save() {
    if (validation !== null || !changed || readOnly) return;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.updateGuardrailPolicy(repositoryKey, proposed);
      setState((current) => current.status === "ready"
        ? { ...current, data: { ...current.data, policy: saved } }
        : current);
      setEditor(editorStateFromPolicy(saved.policy));
      setNotice(t("guardrails.policySaved"));
    } catch (error) {
      setActionError(formatApiError(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function simulate() {
    if (validation !== null) return;
    setBusy(true);
    setActionError(null);
    try {
      setSimulation(await api.simulateGuardrailPolicy(
        repositoryKey,
        gateId === "" ? { policy: proposed } : { gateId, policy: proposed },
      ));
    } catch (error) {
      setActionError(formatApiError(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function buildBaseline() {
    setBaselineBusy(true);
    setBaselineError(null);
    try {
      const { baseline: next } = await api.buildGuardrailBaseline(repositoryKey);
      setState((current) => current.status === "ready"
        ? { ...current, data: { ...current.data, baseline: next } }
        : current);
      setNotice(t("guardrails.baselineBuilding"));
    } catch (error) {
      setBaselineError(formatApiError(error, t));
    } finally {
      setBaselineBusy(false);
    }
  }

  async function togglePrComment(enabled: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await api.patchGuardrailRepository(repositoryKey, { prCommentEnabled: enabled });
      setState((current) => current.status === "ready"
        ? { ...current, data: { ...current.data, repository: { ...current.data.repository, prCommentEnabled: enabled } } }
        : current);
    } catch (error) {
      setActionError(formatApiError(error, t));
    } finally {
      setBusy(false);
    }
  }

  return <div className="min-w-0">
    <PageHeader
      code={t("guardrails.repositoryPageCode")}
      title={repository.displayName}
      description={t("guardrails.repositoryPageDescription")}
      actions={<>
        <Button asChild variant="outline" size="sm">
          <Link to="/guardrails"><ArrowLeft aria-hidden className="size-3" />{t("guardrails.repositoryBack")}</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={`/github?section=actions&repository=${encodeURIComponent(repositoryKey)}`}>
            <Workflow aria-hidden className="size-3" />{t("guardrails.repositoryActionsLink")}
          </Link>
        </Button>
        {!readOnly && <Button type="button" size="sm" disabled={busy || validation !== null || !changed} onClick={() => void save()}>
          <Save aria-hidden className="size-3" />{busy ? t("guardrails.saving") : t("guardrails.savePolicy")}
        </Button>}
      </>}
    />

    {actionError && <AlertBanner>{actionError}</AlertBanner>}
    {notice && <AlertBanner tone="success">{notice}</AlertBanner>}
    {validation && <AlertBanner>{validation.message}</AlertBanner>}

    <div className="grid gap-4">
      {/* 01 — which level of the precedence decides, and whether the editor writes. */}
      <Panel label={t("guardrails.column.policy")} title={t(policySourceLabelKey(policy.policySource, policy.fileInvalidReason))} wrapTitle>
        {policy.fileInvalidReason !== null
          ? <p className="border-b border-chart-3/40 bg-chart-3/[.06] px-4 py-3 text-xs leading-relaxed text-chart-3">
            {t("guardrails.policyFileInvalid")}
          </p>
          : policy.readOnly
            ? <p className="border-b border-chart-5/40 bg-chart-5/[.06] px-4 py-3 text-xs leading-relaxed text-chart-5">
              {t("guardrails.policyFileBanner")}
            </p>
            : null}
        {/* The level is the panel's title; repeating it as a field would print the
            same sentence twice on one line. */}
        <dl className="grid gap-4 p-4 sm:grid-cols-3">
          <Fact label={t("guardrails.policyPath")} value=".csb/guardrails.json" />
          <Fact label="SHA" value={policy.policySha === null ? "—" : policy.policySha.slice(0, 12)} />
          <Fact label={t("guardrails.defaultBranch")} value={repository.defaultBranch} />
        </dl>
        {policy.sentinel !== null && <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {policy.sentinel.updatedBy === null
            ? t("guardrails.policySavedAt", { date: formatDate(policy.sentinel.updatedAt, locale) })
            : t("guardrails.policySavedBy", {
              date: formatDate(policy.sentinel.updatedAt, locale),
              author: policy.sentinel.updatedBy,
            })}
        </p>}
      </Panel>

      <PolicyPresetPicker
        preset={preset}
        readOnly={readOnly}
        onChange={(rules: GuardrailRule[]) => update("rules", rules.map((rule) => ({
          severity: [...rule.severity],
          lifecycle: [...rule.lifecycle],
          decision: rule.decision,
        })))}
      />

      <Panel label={t("guardrails.policyEnvelopeSection")} title={t("guardrails.scopeExecution")} wrapTitle>
        <div className="grid gap-5 p-4 lg:grid-cols-2">
          <Field label={t("guardrails.protectedBranches")} htmlFor="policy-branches" hint={t("guardrails.branchesHint")}>
            <Input
              id="policy-branches"
              className="font-mono"
              disabled={readOnly}
              value={editor.protectedBranches.join(", ")}
              onChange={(event) => update("protectedBranches", event.target.value.split(",").map((value) => value.trim()))}
            />
          </Field>
          <Field label={t("guardrails.model")} htmlFor="policy-model">
            <Input
              id="policy-model"
              className="font-mono"
              disabled={readOnly}
              value={editor.model}
              onChange={(event) => update("model", event.target.value)}
            />
          </Field>
          <Field label="EFFORT" htmlFor="policy-effort">
            <Input
              id="policy-effort"
              className="font-mono"
              disabled={readOnly}
              value={editor.effort}
              onChange={(event) => update("effort", event.target.value)}
            />
          </Field>
          <Field label={t("guardrails.maxCost")} htmlFor="policy-max-cost" hint={t("guardrails.maxCostHint")}>
            <Input
              id="policy-max-cost"
              type="number"
              min="0.01"
              step="0.01"
              className="font-mono"
              disabled={readOnly}
              value={editor.maxCostUsd}
              onChange={(event) => update("maxCostUsd", Number(event.target.value))}
            />
          </Field>
        </div>
      </Panel>

      {/* A `fieldset` is what makes every control inside it inert in one line. Without
          it the rules table invited edits that the save button — absent while the
          repository's file decides — could never have written. */}
      <fieldset disabled={readOnly} className="min-w-0 disabled:opacity-70">
        <PolicyRuleEditor rules={editor.rules} onChange={(rules) => update("rules", rules)} />
      </fieldset>

      <Panel label="SIMULATION" title={t("guardrails.simulationTitle")} wrapTitle>
        {/* The controls live in the body, not in the panel's aside: at 390 the aside
            does not shrink and squeezes the title into one word per line. */}
        {can("analyst", repositoryKey) && <div className="grid gap-3 border-b p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <label className="bench-label" htmlFor="policy-simulation-gate">{t("guardrails.simulationGateLabel")}</label>
            <div className="mt-2">
              <Select value={gateId} onValueChange={setGateId}>
                <SelectTrigger id="policy-simulation-gate" className="w-full" disabled={eligibleGates.length === 0}>
                  <SelectValue placeholder={t("guardrails.selectGate")} />
                </SelectTrigger>
                <SelectContent position="popper" className="rounded-none border-border bg-popover">
                  {eligibleGates.map((gate) => <SelectItem key={gate.id} value={gate.id}>
                    {gate.baseRef} → {gate.headRef} · {gate.outcome ?? gate.status}
                  </SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={busy || validation !== null || eligibleGates.length === 0} onClick={() => void simulate()}>
            <Beaker aria-hidden className="size-3" />{busy ? t("guardrails.simulating") : t("guardrails.simulatePolicy")}
          </Button>
        </div>}
        {simulation === null
          ? <EmptyState
            title={eligibleGates.length > 0 ? t("guardrails.simulationEmpty") : t("guardrails.noArtifact")}
            description={eligibleGates.length > 0 ? t("guardrails.simulationEmptyDescription") : t("guardrails.noArtifactDescription")}
          />
          : <div>
            <div className="grid gap-4 border-b p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
              <GateOutcomeBadge outcome={simulation.decision.outcome} status="completed" />
              <div className="min-w-0">
                <p className="text-sm leading-6">{simulation.decision.summary}</p>
                <p className="mt-1 font-mono text-[9px] uppercase text-muted-foreground">{t("guardrails.simulationMemory")}</p>
              </div>
            </div>
            {simulation.configurationErrors.length > 0
              ? simulation.configurationErrors.map((error, index) => <div key={`${error.field}-${index}`} className="flex items-start gap-2 border-b px-4 py-3 text-xs last:border-b-0">
                <ShieldAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-destructive" />
                <span className="min-w-0"><code className="font-mono text-[10px] text-destructive">{error.field}</code> · {error.message}</span>
              </div>)
              : <p className="px-4 py-3 text-xs text-chart-2">{t("guardrails.noConfigurationErrors")}</p>}
          </div>}
      </Panel>

      <PolicyDiffPreview before={policy.policy} after={proposed} />

      <BaselineCard
        baseline={baseline}
        hasProtectedBranchAction={hasProtectedBranchAction}
        canBuild={isAdmin && repository.source === "github"}
        busy={baselineBusy}
        error={baselineError}
        onBuild={() => void buildBaseline()}
      />

      <Panel label={t("guardrails.prCommentSection")} title={t("guardrails.prCommentTitle")} wrapTitle>
        <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {t("guardrails.prCommentDescription")}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="flex min-w-0 items-center gap-2">
            <span className="bench-label">{t("guardrails.prCommentEnabled")}</span>
            <span className={cx(
              "inline-flex h-5 shrink-0 items-center gap-1.5 border px-1.5 font-mono text-[8px] uppercase tracking-wider",
              repository.prCommentEnabled ? "border-chart-2/45 text-chart-2" : "border-border text-muted-foreground",
            )}>
              <span className="size-1 rounded-full bg-current" />
              {repository.prCommentEnabled ? t("guardrails.stateEnabled") : t("guardrails.stateDisabled")}
            </span>
          </span>
          {/* The same two buttons the GitHub tab uses for an action, for the same
              reason: one control, one verb, and the state said in words next to it. */}
          {isAdmin && <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void togglePrComment(!repository.prCommentEnabled)}
          >
            {repository.prCommentEnabled ? t("guardrails.disableRepository") : t("guardrails.enableRepository")}
          </Button>}
        </div>
        <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {t("guardrails.prCommentPhase3")}
        </p>
      </Panel>

      <Panel label={t("guardrails.gateHistorySection")} title={t("guardrails.gateHistoryTitle")} wrapTitle>
        {gates.length === 0
          ? <EmptyState title={t("guardrails.gateHistoryEmpty")} description={t("guardrails.gateHistoryEmptyDescription")} />
          : <ul className="divide-y">
            {gates.map((gate) => <li key={gate.id}>
              <Link
                to={`/guardrails/${encodeURIComponent(gate.id)}`}
                className={cx("grid min-w-0 gap-3 px-4 py-3 hover:bg-accent xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_10rem] xl:items-center")}
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm">
                    {gate.pullRequestNumber === null ? gate.headRef : `PR #${gate.pullRequestNumber}`}
                  </strong>
                  <span className="mt-1 flex min-w-0 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
                    <GitBranch aria-hidden className="size-2.5 shrink-0" />{gate.baseRef} → {gate.headRef}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <GateOutcomeBadge
                    outcome={gate.outcome}
                    status={gate.status}
                    protectedBaseline={isProtectedBranchBaselineRun(gate)}
                  />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {gate.estimatedUsd > 0 ? formatUsd(gate.estimatedUsd) : "—"}
                  </span>
                </span>
                <span className="font-mono text-[10px] text-muted-foreground xl:text-right">
                  {formatDate(gate.startedAt, locale)}
                </span>
              </Link>
            </li>)}
          </ul>}
      </Panel>
    </div>
  </div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0">
    <dt className="bench-label">{label}</dt>
    <dd className="mt-2 min-w-0 break-all font-mono text-[10px] leading-relaxed">{value}</dd>
  </div>;
}

function Field({ label, htmlFor, hint, children }: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return <div className="min-w-0">
    {/* Mono uppercase, like every other field label in the product. */}
    <label className="bench-label" htmlFor={htmlFor}>{label}</label>
    <div className="mt-2">{children}</div>
    {hint && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
  </div>;
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export default GuardrailRepositoryPage;
