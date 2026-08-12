import { useEffect, useState } from "react";
import type { GateRun, GuardrailPolicy, GuardrailRepository } from "@csb/shared";
import { ArrowLeft, Beaker, Clipboard, Download, FileCheck2, GitBranch, HardDrive, Save, ShieldAlert } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { api, type PolicySimulationResponse } from "../api";
import { GateOutcomeBadge, PolicyDiffPreview, PolicyRuleEditor } from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader } from "../components/ui";
import {
  editorStateFromPolicy,
  policyFromEditor,
  type PolicyEditorState,
  validatePolicyEditor,
} from "../lib/guardrails";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "../i18n";

type PolicyPageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      repository: GuardrailRepository;
      policy: GuardrailPolicy;
      policySource: "workspace" | "base" | "protected_branch" | "default";
      policySha: string | null;
      readOnly: boolean;
      gates: GateRun[];
    };

export function GuardrailPolicyPage() {
  const { t } = useI18n();
  const { repositoryKey = "" } = useParams();
  const [state, setState] = useState<PolicyPageState>({ status: "loading" });
  const [editor, setEditor] = useState<PolicyEditorState | null>(null);
  const [gateId, setGateId] = useState("");
  const [simulation, setSimulation] = useState<PolicySimulationResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function load() {
    setState({ status: "loading" });
    try {
      const [repositoriesResponse, policyResponse, gatesResponse] = await Promise.all([
        api.listGuardrailRepositories(),
        api.getGuardrailPolicy(repositoryKey),
        api.listGates(repositoryKey),
      ]);
      const repository = repositoriesResponse.repositories.find((item) => item.repositoryKey === repositoryKey);
      if (!repository) throw new Error(t("guardrails.repositoryNotFound"));
      const eligibleGates = gatesResponse.gates.filter((gate) => Boolean(gate.artifactPath));
      setState({
        status: "ready",
        repository,
        policy: policyResponse.policy,
        policySource: policyResponse.policySource,
        policySha: policyResponse.policySha,
        readOnly: policyResponse.readOnly,
        gates: gatesResponse.gates,
      });
      setEditor(editorStateFromPolicy(policyResponse.policy));
      setGateId((current) => eligibleGates.some((gate) => gate.id === current) ? current : eligibleGates[0]?.id ?? "");
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : t("guardrails.policyLoadError") });
    }
  }

  useEffect(() => {
    void load();
  }, [repositoryKey]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return (
      <div>
        <AlertBanner>{state.message}</AlertBanner>
        <Button asChild variant="outline" className="min-h-11"><Link to="/guardrails"><ArrowLeft aria-hidden size={14} />{t("guardrails.back")}</Link></Button>
      </div>
    );
  }
  if (!editor) return <Loading />;

  const proposedPolicy = policyFromEditor(editor);
  const validation = validatePolicyEditor(editor);
  const changed = JSON.stringify(state.policy) !== JSON.stringify(proposedPolicy);
  const eligibleGates = state.gates.filter((gate) => Boolean(gate.artifactPath));
  const readOnly = state.readOnly;

  function update<K extends keyof PolicyEditorState>(key: K, value: PolicyEditorState[K]) {
    setEditor((current) => current ? { ...current, [key]: value } : current);
    setMessage(null);
    setSimulation(null);
  }

  async function simulate() {
    if (validation || !gateId) return;
    setBusy(true);
    setMessage(null);
    setActionError(null);
    try {
      setSimulation(await api.simulateGuardrailPolicy(repositoryKey, { gateId, policy: proposedPolicy }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("guardrails.simulationError"));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfirmed() {
    if (validation || !changed || readOnly) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.updateGuardrailPolicy(repositoryKey, proposedPolicy);
      const reloaded = await api.getGuardrailPolicy(repositoryKey);
      setState((current) => current.status === "ready" ? {
        ...current,
        policy: reloaded.policy,
        policySource: reloaded.policySource,
        policySha: reloaded.policySha,
        readOnly: reloaded.readOnly,
      } : current);
      setEditor(editorStateFromPolicy(reloaded.policy));
      setConfirmOpen(false);
      setMessage(t("guardrails.policySaved"));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("guardrails.policySaveError"));
    } finally {
      setBusy(false);
    }
  }

  async function copyProposal() {
    await navigator.clipboard.writeText(`${JSON.stringify(proposedPolicy, null, 2)}\n`);
    setMessage(t("guardrails.proposalCopied"));
  }

  function downloadProposal() {
    const href = URL.createObjectURL(new Blob(
      [`${JSON.stringify(proposedPolicy, null, 2)}\n`],
      { type: "application/json" },
    ));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "guardrails.json";
    anchor.click();
    URL.revokeObjectURL(href);
    setMessage(t("guardrails.proposalDownloaded"));
  }

  return (
    <div className="min-w-0">
      <PageHeader
        code="03B / POLICY"
        title={state.repository.displayName}
        description={t("guardrails.policyDescription")}
        actions={(
          <>
            <Button asChild variant="ghost" className="min-h-11"><Link to={state.repository.lastGateId ? `/guardrails/${encodeURIComponent(state.repository.lastGateId)}` : "/guardrails"}><ArrowLeft aria-hidden size={14} />{t("guardrails.backPipeline")}</Link></Button>
            {state.readOnly ? (
              <>
                <Button variant="outline" className="min-h-11" disabled={Boolean(validation)} onClick={() => void copyProposal()}><Clipboard aria-hidden size={14} />{t("guardrails.copyProposal")}</Button>
                <Button className="min-h-11" disabled={Boolean(validation)} onClick={downloadProposal}><Download aria-hidden size={14} />{t("guardrails.downloadProposal")}</Button>
              </>
            ) : (
              <Button className="min-h-11" disabled={busy || Boolean(validation) || !changed} onClick={() => setConfirmOpen(true)}><Save aria-hidden size={14} />{t("guardrails.savePolicy")}</Button>
            )}
          </>
        )}
      />

      {actionError && <AlertBanner>{actionError}</AlertBanner>}
      {message && <div aria-live="polite"><AlertBanner tone="success">{message}</AlertBanner></div>}
      {validation && <div role="alert"><AlertBanner>{validation.message}</AlertBanner></div>}

      <section className="bench-panel bench-corners mb-4 min-w-0 overflow-hidden" aria-labelledby="policy-authority-title">
        <div className="grid gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
          <span className={`grid size-10 place-items-center border ${state.readOnly ? "border-info/50 text-info" : "border-primary/50 text-primary"}`}>
            {state.readOnly ? <GitBranch aria-hidden size={17} /> : <HardDrive aria-hidden size={17} />}
          </span>
          <div className="min-w-0">
            <div className="bench-label text-primary">POLICY AUTHORITY / {state.readOnly ? t("guardrails.remoteReadOnly") : t("guardrails.localWorkspace")}</div>
            <h2 id="policy-authority-title" className="mt-1 font-heading text-sm font-semibold">{state.readOnly ? t("guardrails.policyRemoteTitle") : t("guardrails.policyLocalTitle")}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{state.readOnly ? t("guardrails.policyRemoteDescription") : t("guardrails.policyLocalDescription")}</p>
          </div>
          <div className="min-w-0 text-left sm:text-right">
            <div className="bench-label">{t("guardrails.source")}</div>
            <div className="mt-1 break-all font-mono text-[10px] text-foreground">{state.policySource}{state.policySha ? ` · ${state.policySha}` : ""}</div>
          </div>
        </div>
      </section>

      <section className="bench-panel bench-corners min-w-0" aria-labelledby="policy-envelope-title">
        <div className="border-b px-4 py-2.5">
          <div className="bench-label text-primary">POLICY ENVELOPE</div>
          <h2 id="policy-envelope-title" className="mt-0.5 text-sm font-semibold">{t("guardrails.scopeExecution")}</h2>
        </div>
        <div className="grid min-w-0 xl:grid-cols-2">
          <div className="grid gap-5 border-b p-4 xl:border-b-0 xl:border-r">
            <EditorField label={t("guardrails.protectedBranches")} htmlFor="policy-branches" hint={t("guardrails.branchesHint")} error={validation?.field === "protectedBranches" ? validation.message : null}>
              <Input id="policy-branches" className="min-h-11 font-mono" aria-invalid={validation?.field === "protectedBranches"} value={editor.protectedBranches.join(", ")} onChange={(event) => update("protectedBranches", event.target.value.split(",").map((value) => value.trim()))} />
            </EditorField>
            <div className="grid gap-5 sm:grid-cols-3">
              <EditorSelect label={t("guardrails.scopeMode")} id="policy-scope-mode" value={editor.scopeMode} onValueChange={(value: PolicyEditorState["scopeMode"]) => update("scopeMode", value)} options={[{ value: "changed", label: t("guardrails.changedPaths") }, { value: "repository", label: t("guardrails.repositoryScope") }]} />
              <EditorField label={t("guardrails.maxPaths")} htmlFor="policy-max-paths" error={validation?.field === "maxChangedPaths" ? validation.message : null}>
                <Input id="policy-max-paths" type="number" min={1} step={1} className="min-h-11 font-mono" aria-invalid={validation?.field === "maxChangedPaths"} value={editor.maxChangedPaths} onChange={(event) => update("maxChangedPaths", Number(event.target.value))} />
              </EditorField>
              <EditorSelect label={t("guardrails.fallback")} id="policy-fallback" value={editor.fallback} onValueChange={(value: PolicyEditorState["fallback"]) => update("fallback", value)} options={[{ value: "repository", label: t("guardrails.repositoryScope") }, { value: "error", label: t("guardrails.stop") }]} />
            </div>
          </div>
          <div className="grid gap-5 p-4">
            <div className="grid gap-5 sm:grid-cols-2">
              <EditorField label={t("guardrails.model")} htmlFor="policy-model" error={validation?.field === "model" ? validation.message : null}>
                <Input id="policy-model" className="min-h-11 font-mono" aria-invalid={validation?.field === "model"} value={editor.model} onChange={(event) => update("model", event.target.value)} />
              </EditorField>
              <EditorField label="Effort" htmlFor="policy-effort" error={validation?.field === "effort" ? validation.message : null}>
                <Input id="policy-effort" className="min-h-11 font-mono" aria-invalid={validation?.field === "effort"} value={editor.effort} onChange={(event) => update("effort", event.target.value)} />
              </EditorField>
              <EditorSelect label={t("guardrails.scanMode")} id="policy-scan-mode" value={editor.scanMode} onValueChange={(value: PolicyEditorState["scanMode"]) => update("scanMode", value)} options={[{ value: "standard", label: "Standard" }, { value: "deep", label: "Deep" }]} />
              <EditorField label={t("guardrails.maxCost")} htmlFor="policy-max-cost" hint={t("guardrails.maxCostHint")} error={validation?.field === "maxCostUsd" ? validation.message : null}>
                <Input id="policy-max-cost" type="number" min="0.01" step="0.01" className="min-h-11 font-mono" aria-invalid={validation?.field === "maxCostUsd"} value={editor.maxCostUsd} onChange={(event) => update("maxCostUsd", Number(event.target.value))} />
              </EditorField>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-4">
        <PolicyRuleEditor rules={editor.rules} onChange={(rules) => update("rules", rules)} />
      </div>

      <section className="bench-panel mt-4 min-w-0" aria-labelledby="policy-simulation-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
          <div>
            <div className="bench-label text-primary">SIMULATION</div>
            <h2 id="policy-simulation-title" className="mt-0.5 text-sm font-semibold">{t("guardrails.simulationTitle")}</h2>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Select value={gateId} onValueChange={setGateId}>
              <SelectTrigger aria-label={t("guardrails.simulationGateLabel")} className="min-h-11 w-full rounded-none sm:w-72"><SelectValue placeholder={t("guardrails.selectGate")} /></SelectTrigger>
              <SelectContent position="popper" className="rounded-none border-border bg-popover">
                {eligibleGates.map((gate) => <SelectItem key={gate.id} value={gate.id} className="min-h-11 rounded-none">{gate.baseRef} → {gate.headRef} · {gate.outcome ?? gate.status}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" className="min-h-11" disabled={busy || Boolean(validation) || !gateId} onClick={() => void simulate()}><Beaker aria-hidden size={14} />{busy ? t("guardrails.simulating") : t("guardrails.simulatePolicy")}</Button>
          </div>
        </div>
        {simulation ? <SimulationReadout simulation={simulation} /> : <EmptyState title={eligibleGates.length ? t("guardrails.simulationEmpty") : t("guardrails.noArtifact")} description={eligibleGates.length ? t("guardrails.simulationEmptyDescription") : t("guardrails.noArtifactDescription")} />}
      </section>

      <div className="mt-4"><PolicyDiffPreview before={state.policy} after={proposedPolicy} /></div>

      {!state.readOnly && <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="bottom" className="mx-auto max-h-[85dvh] overflow-y-auto border-border bg-background sm:left-1/2 sm:max-w-2xl sm:-translate-x-1/2">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-heading"><FileCheck2 aria-hidden size={17} className="text-primary" />{t("guardrails.confirmLocalWrite")}</SheetTitle>
            <SheetDescription>{t("guardrails.confirmLocalWriteDescription")}</SheetDescription>
          </SheetHeader>
          <div className="mx-4 border p-4">
            <div className="bench-label">{t("guardrails.exactPath")}</div>
            <code className="mt-2 block break-all font-mono text-sm text-primary">.csb/guardrails.json</code>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("guardrails.noCommitPush")}</p>
          </div>
          <SheetFooter className="sm:flex-row sm:justify-end">
            <Button variant="outline" className="min-h-11" onClick={() => setConfirmOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
            <Button className="min-h-11" onClick={() => void saveConfirmed()} disabled={busy || Boolean(validation) || !changed}><Save aria-hidden size={14} />{busy ? t("guardrails.saving") : t("guardrails.confirmSave")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>}
    </div>
  );
}

function SimulationReadout({ simulation }: { simulation: PolicySimulationResponse }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="grid gap-4 border-b p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
        <GateOutcomeBadge outcome={simulation.decision.outcome} status="completed" />
        <div>
          <p className="text-sm leading-6">{simulation.decision.summary}</p>
          <p className="mt-1 font-mono text-[9px] uppercase text-muted-foreground">{t("guardrails.simulationMemory")}</p>
        </div>
      </div>
      {simulation.configurationErrors.length > 0 ? (
        <div>
          <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold text-destructive"><ShieldAlert aria-hidden size={15} />{t("guardrails.configurationErrors")}</div>
          {simulation.configurationErrors.map((error, index) => (
            <div key={`${error.field}-${index}`} className="grid gap-3 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
              <div><div className="font-mono text-[9px] text-destructive">{error.field}</div><p className="mt-1 text-xs">{error.message}</p></div>
              <div><div className="bench-label">{t("guardrails.owner")}</div><div className="mt-1 text-xs text-muted-foreground">{t("guardrails.undetermined")}</div></div>
              <div><div className="bench-label">{t("guardrails.expiresAt")}</div><div className="mt-1 text-xs text-muted-foreground">{t("guardrails.undetermined")}</div></div>
            </div>
          ))}
        </div>
      ) : <div className="px-4 py-3 text-xs text-chart-2">{t("guardrails.noConfigurationErrors")}</div>}
    </div>
  );
}

function EditorField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-sm font-semibold" htmlFor={htmlFor}>{label}</label>
      <div className="mt-2">{children}</div>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : hint ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function EditorSelect<T extends string>({
  label,
  id,
  value,
  onValueChange,
  options,
}: {
  label: string;
  id: string;
  value: T;
  onValueChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div>
      <label className="text-sm font-semibold" htmlFor={id}>{label}</label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="mt-2 min-h-11 w-full rounded-none"><SelectValue /></SelectTrigger>
        <SelectContent position="popper" className="rounded-none border-border bg-popover">
          {options.map((option) => <SelectItem key={option.value} value={option.value} className="min-h-11 rounded-none">{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
