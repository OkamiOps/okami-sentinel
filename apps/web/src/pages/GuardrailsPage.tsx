import { repositoryPickerMessages } from "../i18n/repository-picker";
import { useScopedI18n } from "../i18n/scoped";
import { useCallback, useEffect, useState } from "react";
import type {
  DecisionGraphNode,
  GateArtifact,
  GateRun,
  GuardrailRepository,
  GuardrailRepositoryListRow,
  ScanRun,
} from "@csb/shared";
import { ArrowRight, GitBranch, HardDrive, Plus, Square } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import {
  api,
  type EnrollGuardrailRepositoriesRequest,
  type EnrollGuardrailRepositoriesResponse,
  type EnrollGuardrailRepositoryRequest,
} from "../api";
import { ConfirmDialog } from "../components/access/ConfirmDialog";
import { baselineReasonKey, baselineToneOf } from "../lib/guardrail-repository-page";
import { policySourceLabelKey } from "../lib/guardrail-repository-page";
import { Panel } from "../components/ui";
import { revalidateSession, useAuth } from "../auth/AuthProvider";
import {
  DecisionGraph,
  DeleteGateButton,
  EvidenceTrace,
  FindingInspectorDialog,
  GateOutcomeBadge,
  GuardrailPreflightSheet,
  GuardrailScanMonitor,
  PortfolioPipeline,
  PublishGateControl,
  RepositoryEnrollmentForm,
} from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader, cx } from "../components/ui";
import {
  baselineNoticeKey,
  bootstrapBranchLabel,
  gateBaselineNotice,
  guardrailHref,
  isGateActive,
  isProtectedBranchBaselineRun,
  selectGuardrailFindingNode,
  selectGate,
} from "../lib/guardrails";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { formatUsd } from "../format";
import { ApiError, formatApiError } from "../lib/http";
import { useI18n, type TranslationKey } from "../i18n";

type GuardrailsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      repositories: GuardrailRepositoryListRow[];
      gates: GateRun[];
      selectedGate: GateRun | null;
      artifact: GateArtifact | null;
      scans: ScanRun[];
    };

export function GuardrailsPage() {
  const { t, locale } = useI18n();
  const { isAdmin, can } = useAuth();
  const { t: tr } = useScopedI18n(repositoryPickerMessages);
  const { gateId = null } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<GuardrailsState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runRepositoryKey, setRunRepositoryKey] = useState<string | null>(null);
  const [removing, setRemoving] = useState<GuardrailRepositoryListRow | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [gateList, repositoryList, selectedResponse, scanList] = await Promise.all([
        api.listGates(),
        api.listGuardrailRepositories(),
        gateId ? api.getGate(gateId) : Promise.resolve(null),
        api.listScans(),
      ]);
      // No remote call per repository: everything the list shows travels on the row.
      // The old readiness probe cost two GitHub reads per enrolled repository on
      // every load of this page, which is the N+1 the list was rebuilt to remove.
      const selected = selectedResponse?.gate ?? (gateId ? selectGate(gateList.gates, gateId) : null);
      const detail = selectedResponse ?? (selected ? await api.getGate(selected.id) : null);
      setState({
        status: "ready",
        repositories: repositoryList.repositories,
        gates: detail
          ? gateList.gates.map((gate) => gate.id === detail.gate.id ? detail.gate : gate)
          : gateList.gates,
        selectedGate: detail?.gate ?? selected,
        artifact: detail?.artifact ?? null,
        scans: scanList.scans,
      });
    } catch (error) {
      setState({
        status: "error",
        message: formatApiError(error, t),
      });
    }
  }, [gateId]);

  /** Re-reads the rows in place, leaving whatever is open on screen open. */
  const refreshRepositories = useCallback(async () => {
    const { repositories } = await api.listGuardrailRepositories();
    setState((current) => current.status === "ready" ? { ...current, repositories } : current);
  }, []);

  const refreshGate = useCallback((selectedId: string) => {
    void api.getGate(selectedId).then((response) => {
      setState((current) => {
        if (current.status !== "ready" || current.selectedGate?.id !== selectedId) return current;
        return {
          ...current,
          gates: current.gates.map((gate) => gate.id === selectedId ? response.gate : gate),
          selectedGate: response.gate,
          artifact: response.artifact,
        };
      });
    }).catch((error) => {
      setActionError(formatApiError(error, t));
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.status !== "ready" || !state.selectedGate || !isGateActive(state.selectedGate.status)) return;
    const selectedId = state.selectedGate.id;
    const source = new EventSource(api.gateEventsUrl(selectedId));
    source.onerror = () => revalidateSession();
    const refreshSelected = () => refreshGate(selectedId);
    for (const name of ["status", "scan", "decision", "done", "error"] as const) {
      source.addEventListener(name, refreshSelected);
    }
    // Gate SSE is the fast path. Polling is the reconciliation path when the
    // terminal event races the browser subscription or a laptop sleeps.
    const poll = window.setInterval(refreshSelected, 3_500);
    return () => {
      source.close();
      window.clearInterval(poll);
    };
  }, [refreshGate, state.status, state.status === "ready" ? state.selectedGate?.id : null, state.status === "ready" ? state.selectedGate?.status : null]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return (
      <div>
        <AlertBanner>{state.message}</AlertBanner>
        <Button variant="outline" className="min-h-11" onClick={() => void load()}>{t("guardrails.retry")}</Button>
      </div>
    );
  }
  const readyState = state;

  const selectedNode = readyState.artifact
    ? selectGuardrailFindingNode(readyState.artifact, params.get("node"))
    : null;
  const inspectedNodeId = params.get("inspect");
  const inspectedNode = readyState.artifact && inspectedNodeId
    ? selectGuardrailFindingNode(readyState.artifact, inspectedNodeId)
    : null;

  function selectLane(gate: GateRun) {
    const nodeId = gate.id === readyState.selectedGate?.id ? selectedNode?.id : null;
    navigate(guardrailHref(gate.id, nodeId));
  }

  function selectNode(node: DecisionGraphNode) {
    const next = new URLSearchParams(params);
    next.set("node", node.id);
    if (node.findingIdentity) next.set("inspect", node.id);
    else next.delete("inspect");
    setParams(next, { replace: true });
  }

  function closeFindingInspector() {
    const next = new URLSearchParams(params);
    next.delete("inspect");
    setParams(next, { replace: true });
  }

  async function enroll(request: EnrollGuardrailRepositoryRequest) {
    setBusy(true);
    setActionError(null);
    try {
      await api.enrollGuardrailRepository(request);
      setEnrollOpen(false);
      await load();
    } catch (error) {
      setActionError(error instanceof Error && error.message.includes("repository_already_registered") ? tr("duplicate") : formatApiError(error, t));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function enrollBatch(request: EnrollGuardrailRepositoriesRequest): Promise<EnrollGuardrailRepositoriesResponse> {
    setBusy(true);
    setActionError(null);
    try {
      const answer = await api.enrollGuardrailRepositories(request);
      // The rows are refreshed **without** going through `load()`: that sets the page
      // back to its loading state, which unmounts the sheet — and with it the partial
      // result the operator is reading and the selection they just made.
      await refreshRepositories();
      return answer;
    } catch (error) {
      setActionError(formatApiError(error, t));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function setRepositoryEnabled(repositoryKey: string, enabled: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await api.patchGuardrailRepository(repositoryKey, { enabled });
      await refreshRepositories();
    } catch (error) {
      setActionError(formatApiError(error, t) || t("guardrails.repositoryPatchError"));
    } finally {
      setBusy(false);
    }
  }

  async function removeRepository(repositoryKey: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteGuardrailRepository(repositoryKey);
      setRemoving(null);
      await refreshRepositories();
    } catch (error) {
      setActionError(error instanceof ApiError && error.message === "repository_has_active_gate"
        ? t("guardrails.removeRepositoryBusy")
        : formatApiError(error, t) || t("guardrails.removeRepositoryError"));
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelected() {
    const selectedGateId = readyState.selectedGate?.id;
    if (!selectedGateId) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelGate(selectedGateId);
      await load();
    } catch (error) {
      setActionError(formatApiError(error, t));
    } finally {
      setBusy(false);
    }
  }

  function updateSelectedGate(gate: GateRun) {
    setState((current) => {
      if (current.status !== "ready" || current.selectedGate?.id !== gate.id) return current;
      return {
        ...current,
        gates: current.gates.map((item) => item.id === gate.id ? gate : item),
        selectedGate: gate,
      };
    });
  }

  function handleGateDeleted(deletedGateId: string) {
    setState((current) => {
      if (current.status !== "ready") return current;
      return {
        ...current,
        gates: current.gates.filter((gate) => gate.id !== deletedGateId),
        selectedGate: current.selectedGate?.id === deletedGateId ? null : current.selectedGate,
        artifact: current.selectedGate?.id === deletedGateId ? null : current.artifact,
      };
    });
    navigate("/guardrails", { replace: true });
  }

  const selectedGateActive = readyState.selectedGate ? isGateActive(readyState.selectedGate.status) : false;
  const setupRepositoryKey = readyState.selectedGate?.repositoryKey ?? null;
  const selectedRepository = readyState.selectedGate
    ? readyState.repositories.find((repository) => repository.repositoryKey === readyState.selectedGate?.repositoryKey) ?? null
    : null;
  const protectedBaseline = readyState.selectedGate
    ? isProtectedBranchBaselineRun(readyState.selectedGate, readyState.artifact)
    : false;
  const bootstrapBranch = readyState.selectedGate
    ? bootstrapBranchLabel(readyState.selectedGate, readyState.artifact, selectedRepository?.defaultBranch)
    : "";
  const noticeKey = baselineNoticeKey(gateBaselineNotice(readyState.artifact));
  const baselineNoticeMessage = noticeKey === null ? null : t(noticeKey);

  return (
    <div className="min-w-0">
      <PageHeader
        code="03 / GUARDRAILS"
        title={gateId ? t("guardrails.title") : t("guardrails.projectsTitle")}
        description={gateId ? t("guardrails.description") : t("guardrails.projectsDescriptionPhase2")}
        actions={(
          <>
            {gateId && <Button asChild variant="outline" className="min-h-11"><Link to="/guardrails"><ArrowRight aria-hidden size={14} className="rotate-180" />{t("guardrails.backProjects")}</Link></Button>}
            <Button asChild variant="configuration" className="min-h-11">
              <Link to={setupRepositoryKey ? `/guardrails/setup?repository=${encodeURIComponent(setupRepositoryKey)}` : "/guardrails/setup"}><GitBranch aria-hidden size={14} />{t("guardrails.setup")}</Link>
            </Button>
            {gateId && isAdmin && <Button className="min-h-11" disabled={!setupRepositoryKey || selectedGateActive} onClick={() => { setRunRepositoryKey(setupRepositoryKey); setRunOpen(true); }}><ArrowRight aria-hidden size={14} />{t("guardrails.scanNow")}</Button>}
            {selectedGateActive && can("operator", setupRepositoryKey) && (
              <Button variant="destructive" className="min-h-11" onClick={() => void cancelSelected()} disabled={busy}>
                <Square aria-hidden size={13} />{t("guardrails.cancel")}
              </Button>
            )}
            {readyState.selectedGate && !selectedGateActive && (
              <DeleteGateButton gate={readyState.selectedGate} onDeleted={() => handleGateDeleted(readyState.selectedGate!.id)} />
            )}
            {isAdmin && <EnrollmentSheet open={enrollOpen} onOpenChange={setEnrollOpen} busy={busy} onEnroll={enroll} onEnrollBatch={enrollBatch} />}
            {isAdmin && (
              <GuardrailPreflightSheet
                repositories={readyState.repositories}
                initialRepositoryKey={runRepositoryKey ?? undefined}
                open={runOpen}
                onOpenChange={setRunOpen}
                onError={setActionError}
                onStarted={(gate) => navigate(guardrailHref(gate.id))}
              />
            )}
          </>
        )}
      />

      {actionError && <AlertBanner>{actionError}</AlertBanner>}

      {readyState.selectedGate ? (
        <PortfolioPipeline
          repositories={readyState.repositories}
          gates={readyState.gates}
          selectedGateId={readyState.selectedGate?.id ?? null}
          selectedArtifact={readyState.artifact}
          scans={readyState.scans}
          onSelect={selectLane}
        />
      ) : (
        <>
          <RepositoryList
            repositories={readyState.repositories}
            busy={busy}
            canAdminister={isAdmin}
            onToggle={(repositoryKey, enabled) => void setRepositoryEnabled(repositoryKey, enabled)}
            onRemove={setRemoving}
          />
          <GateList repositories={readyState.repositories} gates={readyState.gates} />
        </>
      )}

      {removing !== null && <ConfirmDialog
        open
        destructive
        pending={busy}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={t("guardrails.removeRepositoryTitle", { name: removing.displayName })}
        description={t("guardrails.removeRepositoryConfirm")}
        onConfirm={() => void removeRepository(removing.repositoryKey)}
      />}

      {readyState.selectedGate && readyState.selectedGate.error && (
        <div className="mt-4"><AlertBanner>{gateFailureMessage(readyState.selectedGate.error, t)}</AlertBanner></div>
      )}
      {/* A gate that had nothing to compare against says so in the words the artifact
          recorded, including *why* when an existing baseline was not comparable. The
          older "run the gate on main" sentence is kept for a protected-branch run and
          for artifacts written before the notice existed. */}
      {readyState.selectedGate?.outcome === "bootstrap" && (
        <div className="mt-4"><AlertBanner tone="warning">{protectedBaseline
          ? t("guardrails.bootstrapProtected", { branch: bootstrapBranch })
          : baselineNoticeMessage === null
            ? t("guardrails.bootstrapMissing", { branch: bootstrapBranch })
            : baselineNoticeMessage}</AlertBanner></div>
      )}
      {readyState.selectedGate?.outcome === "no_changes" && (
        <div className="mt-4"><AlertBanner tone="success">{t("guardrails.noChangesBanner")}</AlertBanner></div>
      )}

      {readyState.selectedGate?.status === "completed" && readyState.artifact && (
        <div className="mt-4">
          <PublishGateControl gate={readyState.selectedGate} artifact={readyState.artifact} onGateChange={updateSelectedGate} />
        </div>
      )}

      {readyState.selectedGate?.executor === "sentinel-managed" && readyState.selectedGate.scanId && (
        <GuardrailScanMonitor gate={readyState.selectedGate} onScanTerminal={() => refreshGate(readyState.selectedGate!.id)} />
      )}

      {readyState.selectedGate && (readyState.selectedGate.executor !== "sentinel-managed" || !readyState.selectedGate.scanId) && !readyState.artifact && (
        <section className="bench-panel mt-4">
          <EmptyState
            title={readyState.selectedGate.status === "cancelling" ? t("guardrails.status.cancelling") : selectedGateActive ? t("guardrails.scanStartingTitle") : t("guardrails.artifactUnavailable")}
            description={readyState.selectedGate.status === "cancelling" ? t("guardrails.cancellationPending") : selectedGateActive
              ? t("guardrails.scanStartingDescription")
              : t("guardrails.noCausalEvidence")}
          />
        </section>
      )}

      {readyState.artifact && selectedNode && (
        <div className="mt-4 grid min-w-0 gap-4">
          <DecisionGraph
            artifact={readyState.artifact}
            selectedNodeId={selectedNode.id}
            onSelect={selectNode}
          />
          <EvidenceTrace artifact={readyState.artifact} node={selectedNode} />
        </div>
      )}
      {readyState.artifact && (
        <FindingInspectorDialog
          artifact={readyState.artifact}
          node={inspectedNode}
          open={inspectedNode !== null}
          onOpenChange={(open) => { if (!open) closeFindingInspector(); }}
        />
      )}
    </div>
  );
}

function gateFailureMessage(code: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (code === "actions_cancellation_failed") return t("guardrails.cancellationFailed");
  if (code === "actions_cancellation_too_late") return t("guardrails.cancellationTooLate");
  if (code === "linked_scan_failed" || code === "linked_scan_incomplete") {
    return t("guardrails.linkedScanFailed");
  }
  if (code === "linked_scan_cancelled") {
    return t("guardrails.linkedScanCancelled");
  }
  if (code === "gate_finalization_interrupted") {
    return t("guardrails.finalizationInterrupted");
  }
  if (code === "snapshot_materialization_failed") {
    return t("guardrails.snapshotDownloadFailed");
  }
  if (code === "snapshot_archive_invalid") {
    return t("guardrails.snapshotArchiveInvalid");
  }
  if (code === "snapshot_limit_exceeded") {
    return t("guardrails.snapshotLimitExceeded");
  }
  return code;
}

/**
 * One grid for the header and every row, so the baseline, the last analysis, the
 * action count and the verdict start at the same x on every line instead of being
 * measured by whatever that row's buttons happen to be.
 */
const REPOSITORY_GRID = "xl:grid-cols-[minmax(0,0.9fr)_minmax(0,2.4fr)_17rem]";

/** The five cells of a repository row, header and body on the same tracks. */
const REPOSITORY_CELLS = "sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,1fr)]";

const BASELINE_TONE = {
  good: "border-chart-2/45 text-chart-2",
  warning: "border-chart-3/45 text-chart-3",
  active: "border-primary/45 text-primary",
  neutral: "border-border text-muted-foreground",
  risk: "border-destructive/45 text-destructive",
} as const;

/**
 * `/guardrails` — the repositories under guardrail. Everything on a row travels on
 * the row: no GitHub call, and no second request per repository.
 */
function RepositoryList({ repositories, busy, canAdminister, onToggle, onRemove }: {
  repositories: readonly GuardrailRepositoryListRow[];
  busy: boolean;
  canAdminister: boolean;
  onToggle: (repositoryKey: string, enabled: boolean) => void;
  onRemove: (repository: GuardrailRepositoryListRow) => void;
}) {
  const { t, locale } = useI18n();
  return <Panel
    className="mb-4"
    label={t("guardrails.repositoriesSection")}
    title={t("guardrails.repositoriesTitle")}
    wrapTitle
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      {t("guardrails.repositoriesDescription")}
    </p>
    {repositories.length === 0
      ? <EmptyState title={t("guardrails.repositoriesEmpty")} description={t("guardrails.repositoriesEmptyDescription")} />
      : <>
        <div className={cx("hidden gap-3 border-b bg-secondary/[.16] px-4 py-2", REPOSITORY_GRID, "xl:grid")}>
          <span className="bench-label">{t("guardrails.column.repository")}</span>
          <dl className={cx("grid gap-x-4", REPOSITORY_CELLS)}>
            <span className="bench-label pl-3">{t("guardrails.column.baseline")}</span>
            <span className="bench-label pl-3">{t("guardrails.column.verdict")}</span>
            <span className="bench-label pl-3">{t("guardrails.column.lastAnalysis")}</span>
            <span className="bench-label pl-3">{t("guardrails.column.actions")}</span>
            <span className="bench-label pl-3">{t("guardrails.column.policy")}</span>
          </dl>
          <span />
        </div>
        <ul className="divide-y">
          {repositories.map((repository) => {
            const tone = baselineToneOf(repository.baseline);
            const reasonKey = baselineReasonKey(repository.baseline);
            return <li key={repository.repositoryKey}>
              <article className={cx("grid min-w-0 gap-3 px-4 py-4 xl:items-start", REPOSITORY_GRID)}>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link
                      to={`/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}`}
                      className="min-w-0 break-words text-sm font-semibold hover:underline"
                    >{repository.displayName}</Link>
                    {!repository.enabled && <span className="inline-flex h-5 shrink-0 items-center border border-border px-1.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
                      {t("guardrails.stateDisabled")}
                    </span>}
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1 break-all font-mono text-[10px] text-muted-foreground">
                    {repository.source === "github" ? <GitBranch aria-hidden size={10} className="shrink-0" /> : <HardDrive aria-hidden size={10} className="shrink-0" />}
                    {repository.defaultBranch}
                  </div>
                </div>

                <dl className={cx("grid min-w-0 grid-cols-2 gap-x-4 gap-y-3", REPOSITORY_CELLS)}>
                  <RepositoryCell label={t("guardrails.column.baseline")}>
                    {/* The word is the chip; the reason is a line under it, so a stale
                        baseline does not wrap a two-line sentence inside a border and
                        make this row taller than the ones beside it. */}
                    <span className={cx(
                      "inline-flex h-5 items-center gap-1.5 border px-1.5 font-mono text-[8px] uppercase tracking-wider",
                      BASELINE_TONE[tone],
                    )}>
                      <span className={cx("size-1 rounded-full bg-current", tone === "active" && "live-dot")} />
                      {t(`guardrails.baseline.${repository.baseline.state}` as TranslationKey)}
                    </span>
                    {reasonKey !== null && <span className="mt-1 block font-mono text-[9px] leading-tight text-muted-foreground">
                      {t(reasonKey, { code: repository.baseline.staleReason ?? "" })}
                    </span>}
                  </RepositoryCell>
                  <RepositoryCell label={t("guardrails.column.verdict")}>
                    {repository.lastGate === null
                      ? <span className="font-mono text-[10px] text-muted-foreground">—</span>
                      : <Link to={guardrailHref(repository.lastGate.gateId)} className="inline-flex">
                        <GateOutcomeBadge outcome={repository.lastGate.outcome} status="completed" />
                      </Link>}
                  </RepositoryCell>
                  <RepositoryCell label={t("guardrails.column.lastAnalysis")}>
                    <span className="font-mono text-[10px]">
                      {repository.lastGate?.completedAt == null
                        ? t("guardrails.repositoryNever")
                        : formatProjectDate(repository.lastGate.completedAt, locale)}
                    </span>
                  </RepositoryCell>
                  <RepositoryCell label={t("guardrails.column.actions")}>
                    <span className="font-mono text-[10px]">{repository.enabledActionCount}</span>
                  </RepositoryCell>
                  <RepositoryCell label={t("guardrails.column.policy")}>
                    <span className="break-words font-mono text-[10px]">
                      {t(policySourceLabelKey(repository.policySource, null))}
                    </span>
                  </RepositoryCell>
                </dl>

                <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/guardrails/repositories/${encodeURIComponent(repository.repositoryKey)}`}>{t("guardrails.openRepository")}</Link>
                  </Button>
                  {canAdminister && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onToggle(repository.repositoryKey, !repository.enabled)}>
                    {repository.enabled ? t("guardrails.disableRepository") : t("guardrails.enableRepository")}
                  </Button>}
                  {canAdminister && <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => onRemove(repository)}
                  >{t("guardrails.removeRepository")}</Button>}
                </div>
              </article>
            </li>;
          })}
        </ul>
      </>}
  </Panel>;
}

function RepositoryCell({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0 border-l border-border pl-3">
    {/* Below `xl` each cell carries its own label; at `xl` the header above does, and
        repeating it would print the same word down one column. */}
    <dt className="bench-label xl:hidden">{label}</dt>
    <dd className="mt-1 min-w-0 xl:mt-0">{children}</dd>
  </div>;
}

/**
 * The gate list below the repositories. One row per gate, in the order they started,
 * with the link to the gate's own page — which is where the diff, the decision graph
 * and the evidence already live. The three-pane launchpad that used to stand here
 * repeated the repository list above it and guessed a baseline word the projection
 * now reports, so it said two things about one fact.
 */
function GateList({ repositories, gates }: {
  repositories: readonly GuardrailRepositoryListRow[];
  gates: readonly GateRun[];
}) {
  const { t, locale } = useI18n();
  const nameOf = (repositoryKey: string) =>
    repositories.find((row) => row.repositoryKey === repositoryKey)?.displayName ?? repositoryKey;
  const ordered = [...gates].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  return <Panel label={t("guardrails.gatesSection")} title={t("guardrails.gatesTitle")} wrapTitle>
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      {t("guardrails.gatesDescription")}
    </p>
    {ordered.length === 0
      ? <EmptyState title={t("guardrails.gateHistoryEmpty")} description={t("guardrails.gateHistoryEmptyDescription")} />
      : <>
        <div className={cx("hidden gap-3 border-b bg-secondary/[.16] px-4 py-2", GATE_GRID, "xl:grid")}>
          <span className="bench-label">{t("guardrails.column.repository")}</span>
          <dl className="grid grid-cols-3 gap-x-4">
            <span className="bench-label pl-3">{t("guardrails.column.verdict")}</span>
            <span className="bench-label pl-3">{t("guardrails.column.cost")}</span>
            <span className="bench-label pl-3">{t("guardrails.column.startedAt")}</span>
          </dl>
          <span />
        </div>
        <ul className="divide-y">
          {ordered.map((gate) => <li key={gate.id}>
            <article className={cx("grid min-w-0 gap-3 px-4 py-4 xl:items-center", GATE_GRID)}>
              <div className="min-w-0">
                <strong className="block truncate text-sm">
                  {gate.pullRequestNumber === null ? gate.headRef : `PR #${gate.pullRequestNumber}`}
                </strong>
                <span className="mt-1 flex min-w-0 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
                  <GitBranch aria-hidden size={10} className="shrink-0" />
                  {nameOf(gate.repositoryKey)} · {gate.baseRef} → {gate.headRef}
                </span>
              </div>
              <dl className="grid min-w-0 grid-cols-3 gap-x-4 gap-y-3">
                <RepositoryCell label={t("guardrails.column.verdict")}>
                  <GateOutcomeBadge
                    outcome={gate.outcome}
                    status={gate.status}
                    protectedBaseline={isProtectedBranchBaselineRun(gate)}
                  />
                </RepositoryCell>
                <RepositoryCell label={t("guardrails.column.cost")}>
                  <span className="font-mono text-[10px]">{gate.estimatedUsd > 0 ? formatUsd(gate.estimatedUsd) : "—"}</span>
                </RepositoryCell>
                <RepositoryCell label={t("guardrails.column.startedAt")}>
                  <span className="font-mono text-[10px]">{formatProjectDate(gate.startedAt, locale)}</span>
                </RepositoryCell>
              </dl>
              <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
                <Button asChild variant="outline" size="sm">
                  <Link to={guardrailHref(gate.id)}>{t("guardrails.openGate")}</Link>
                </Button>
              </div>
            </article>
          </li>)}
        </ul>
      </>}
  </Panel>;
}

const GATE_GRID = "xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_8rem]";

function formatProjectDate(value: string, locale: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "2-digit" }).format(date); }


function EnrollmentSheet({
  open,
  onOpenChange,
  busy,
  onEnroll,
  onEnrollBatch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onEnroll: (request: EnrollGuardrailRepositoryRequest) => Promise<void>;
  onEnrollBatch: (request: EnrollGuardrailRepositoriesRequest) => Promise<EnrollGuardrailRepositoriesResponse>;
}) {
  const { t } = useI18n();
  const { t: tr } = useScopedI18n(repositoryPickerMessages);
  const [expanded, setExpanded] = useState(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="outline" className="min-h-11"><Plus aria-hidden size={14} />{t("guardrails.addRepositories")}</Button>
      </SheetTrigger>
      <SheetContent className={`w-full gap-0 border-border bg-background ${expanded ? "data-[side=right]:sm:max-w-[min(92vw,1200px)]" : "data-[side=right]:sm:max-w-[48rem]"}`}>

        <SheetHeader className="border-b pr-14">
          <Button type="button" variant="outline" size="sm" aria-pressed={expanded} onClick={() => setExpanded((value) => !value)} className="hidden w-fit sm:inline-flex">{expanded ? tr("collapse") : tr("expand")}</Button>
          <SheetTitle className="font-heading">{t("guardrails.addRepositories")}</SheetTitle>
          <SheetDescription>{t("guardrails.enrollDescription")}</SheetDescription>
        </SheetHeader>
        <RepositoryEnrollmentForm active={open} busy={busy} onEnroll={onEnroll} onEnrollBatch={onEnrollBatch} />
      </SheetContent>
    </Sheet>
  );
}
