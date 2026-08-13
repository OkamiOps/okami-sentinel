import { useEffect, useState } from "react";
import type { GuardrailGitHubStatus, GuardrailRepository } from "@csb/shared";
import { Check, Clipboard, Download, GitBranch, RotateCw, ShieldAlert, Sparkles, Workflow } from "lucide-react";

import type { GuardrailActionsStatus, GuardrailAutomationTriggers, GuardrailCallerWorkflow } from "../../api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cx } from "../ui";
import { useI18n } from "../../i18n";

export function GitHubStatusPanel({
  repository,
  status,
  actionsStatus,
  callerWorkflow,
  baselineError,
  busy,
  onRefresh,
  onConfigureWorkflow,
  onSyncBaseline,
}: {
  repository: GuardrailRepository;
  status: GuardrailGitHubStatus;
  actionsStatus: GuardrailActionsStatus | null;
  callerWorkflow: GuardrailCallerWorkflow | null;
  baselineError: string | null;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onConfigureWorkflow: (triggers: GuardrailAutomationTriggers) => Promise<void>;
  onSyncBaseline: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [triggers, setTriggers] = useState<GuardrailAutomationTriggers>(() => actionsStatus?.triggers ?? { push: false, pullRequest: true, merge: true });
  const remoteReady = status.remote.ready && status.auth.ready && status.permissions.ready;
  const managedReady = remoteReady;
  const actionsReady = remoteReady && actionsStatus?.ready === true;
  const actionStatusLabel = actionsStatus ? t(`guardrails.actionsStatus.${actionsStatus.code}`) : t("guardrails.actionsChecking");

  useEffect(() => {
    if (actionsStatus?.triggers) setTriggers(actionsStatus.triggers);
  }, [actionsStatus?.triggers?.push, actionsStatus?.triggers?.pullRequest, actionsStatus?.triggers?.merge]);

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
          <h2 id="github-capability-title" className="mt-1 font-heading text-base font-semibold">{t("guardrails.remoteAuthorityTitle")}</h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">{t("guardrails.remoteAuthorityDescription")}</p>
        </div>
        <Button variant="outline" className="m-4 min-h-11" disabled={busy} onClick={() => void onRefresh()}><RotateCw aria-hidden size={14} />{t("guardrails.refreshCapabilities")}</Button>
      </div>

      <div className="grid border-b sm:grid-cols-2 xl:grid-cols-4">
        <CapabilityCell icon={<GitBranch aria-hidden size={15} />} code="01 / AUTHORITY" title="GitHub App" ready={remoteReady} detail={remoteReady ? t("guardrails.githubAuthorityReady") : status.remote.message} />
        <CapabilityCell icon={<ShieldAlert aria-hidden size={15} />} code="02 / BASELINE" title="Baseline authority" ready={status.baseline.ready} detail={status.baseline.ready ? t("guardrails.baselineAuthorityReady") : status.baseline.message} />
        <CapabilityCell icon={<ShieldAlert aria-hidden size={15} />} code="03 / MANAGED" title="Sentinel managed" ready={managedReady} detail={managedReady ? t("guardrails.managedReadyDetail") : status.auth.message} />
        <CapabilityCell icon={<Workflow aria-hidden size={15} />} code="04 / ACTIONS" title="GitHub Actions" ready={actionsReady} detail={actionStatusLabel} />
      </div>

      <div className="grid min-w-0 xl:grid-cols-[minmax(18rem,.7fr)_minmax(22rem,1fr)]">
        <div className="min-w-0 border-b p-5 xl:border-b-0 xl:border-r xl:p-6">
          <div className="bench-label text-primary">{t("guardrails.enrolledIdentity")}</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <IdentityRow label={t("guardrails.repository")} value={`${repository.remoteOwner}/${repository.remoteName}`} />
            <IdentityRow label={t("guardrails.defaultBranch")} value={repository.defaultBranch} />
            <IdentityRow label="Installation ID" value={repository.githubInstallationId ?? "—"} />
            <IdentityRow label="Repository ID" value={repository.githubRepositoryId ?? "—"} />
            <IdentityRow label={t("guardrails.defaultExecutor")} value={repository.defaultExecutor} />
            <IdentityRow label="Baseline" value={status.baseline.ready ? t("guardrails.authorized") : t("guardrails.actionRequired")} />
          </div>
        </div>
        <div className="min-w-0">
          <div className={cx("border-b p-5 xl:p-6", actionsReady ? "bg-chart-2/[.035]" : "bg-destructive/[.035]")}>
            <div className={cx("flex items-center gap-2 bench-label", actionsReady ? "text-chart-2" : "text-destructive")}>{actionsReady ? <Check aria-hidden size={14} /> : <ShieldAlert aria-hidden size={14} />}GITHUB ACTIONS READINESS</div>
            <h3 className="mt-3 font-heading text-xl font-semibold">{actionsReady ? t("guardrails.callerReady") : t("guardrails.actionRequired")}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{actionStatusLabel}</p>
          </div>
          <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(16rem,.55fr)]">
            <div className="min-w-0 border-b p-5 md:border-b-0 md:border-r xl:p-6">
              <div className="bench-label">CALLER WORKFLOW</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("guardrails.configureAutomaticallyDetail")}</p>
              <code className="mt-4 block break-all border bg-secondary/30 p-3 font-mono text-[10px] text-primary">{actionsStatus?.workflowPath ?? ".github/workflows/csb-security-change-gate.yml"}</code>
              <div className="mt-4 grid gap-2" role="group" aria-label={t("guardrails.automationTriggers")}>
                <TriggerChoice checked={triggers.push} label={t("guardrails.triggerPush")} detail={t("guardrails.triggerPushDetail")} onChange={(push) => setTriggers((current) => ({ ...current, push }))} />
                <TriggerChoice checked={triggers.pullRequest} label={t("guardrails.triggerPullRequest")} detail={t("guardrails.triggerPullRequestDetail")} onChange={(pullRequest) => setTriggers((current) => ({ ...current, pullRequest }))} />
                <TriggerChoice checked={triggers.merge} label={t("guardrails.triggerMerge")} detail={t("guardrails.triggerMergeDetail")} onChange={(merge) => setTriggers((current) => ({ ...current, merge }))} />
              </div>
              <Button className="mt-4 min-h-11 w-full" disabled={busy || !remoteReady} onClick={() => void onConfigureWorkflow(triggers)}><Sparkles aria-hidden size={14} />{actionsReady ? t("guardrails.updateAutomation") : t("guardrails.configureAutomatically")}</Button>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{t("guardrails.configureAutomaticallyDetail")}</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Button variant="outline" className="min-h-11" disabled={!callerWorkflow} onClick={() => void copyCaller()}><Clipboard aria-hidden size={14} />{copied ? t("guardrails.copied") : t("guardrails.copyYaml")}</Button>
                <Button variant="outline" className="min-h-11" disabled={!callerWorkflow} onClick={downloadCaller}><Download aria-hidden size={14} />{t("guardrails.downloadFile")}</Button>
              </div>
              {!callerWorkflow && <p className="mt-3 border-l-2 border-destructive pl-3 text-xs leading-5 text-destructive">{actionStatusLabel}</p>}
            </div>
            <div className="p-5 xl:p-6">
              <div className="bench-label">BASELINE ARTIFACT</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{status.baseline.ready ? t("guardrails.baselineAuthorityReady") : status.baseline.message}</p>
              {baselineError && <p className="mt-4 break-words border border-destructive/40 bg-destructive/[.04] p-3 text-xs leading-5 text-destructive">{baselineError}</p>}
              <Button className="mt-4 min-h-11 w-full" disabled={busy || !remoteReady || (repository.defaultExecutor === "github-actions" && !actionsReady)} onClick={() => void onSyncBaseline()}><RotateCw aria-hidden size={14} />{t("guardrails.syncBaseline")}</Button>
              <p className="mt-3 text-[10px] leading-4 text-muted-foreground">{t("guardrails.baselineArtifactHint")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function TriggerChoice({ checked, label, detail, onChange }: { checked: boolean; label: string; detail: string; onChange: (checked: boolean) => void }) {
  return <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 border p-3 transition-colors hover:bg-secondary/30"><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} aria-label={label} /><span className="min-w-0"><strong className="block text-xs">{label}</strong><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{detail}</span></span></label>;
}

function CapabilityCell({ icon, code, title, ready, detail }: { icon: React.ReactNode; code: string; title: string; ready: boolean; detail: string }) {
  return <div className="min-w-0 border-b p-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><div className={cx("bench-label", ready ? "text-chart-2" : "text-destructive")}>{code}</div><div className="mt-2 flex items-center gap-2"><span className={cx("grid size-7 place-items-center border", ready ? "border-chart-2/50 text-chart-2" : "border-destructive/50 text-destructive")}>{ready ? <Check aria-hidden size={14} /> : icon}</span><strong className="text-sm">{title}</strong></div><p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{detail}</p></div>;
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-l border-primary/40 pl-3"><div className="font-mono text-[8px] uppercase tracking-[.12em] text-muted-foreground">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-foreground">{value}</div></div>;
}
