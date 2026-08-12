import { useEffect, useState } from "react";
import type {
  GateExecutorKind,
  GateRun,
  GuardrailRepository,
} from "@csb/shared";
import {
  Cloud,
  GitBranch,
  GitCompareArrows,
  GitPullRequestArrow,
  HardDrive,
  LockKeyhole,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { api, type GuardrailTargetPreview } from "../../api";
import {
  initialGuardrailTargetDraft,
  preflightFingerprint,
  targetFromDraft,
  type GuardrailTargetDraft,
} from "../../lib/guardrails-target";
import { AlertBanner } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ChoiceCard } from "./ChoiceCard";
import { useI18n } from "../../i18n";

export function GuardrailPreflightSheet({
  repositories,
  open,
  onOpenChange,
  onStarted,
  onError,
}: {
  repositories: GuardrailRepository[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (gate: GateRun) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [repositoryKey, setRepositoryKey] = useState(repositories[0]?.repositoryKey ?? "");
  const selected = repositories.find((repository) => repository.repositoryKey === repositoryKey)
    ?? repositories[0]
    ?? null;
  const [draft, setDraft] = useState<GuardrailTargetDraft>(() => selected
    ? initialGuardrailTargetDraft(selected)
    : { kind: "compare", pullRequestNumber: "", baseRef: "main", headRef: "HEAD" });
  const [executor, setExecutor] = useState<GateExecutorKind>(selected?.defaultExecutor ?? "sentinel-managed");
  const [preview, setPreview] = useState<GuardrailTargetPreview | null>(null);
  const [acceptedFingerprint, setAcceptedFingerprint] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = selected ? targetFromDraft(selected, draft) : null;
  const fingerprint = selected && target
    ? preflightFingerprint(selected.repositoryKey, executor, target)
    : null;
  const previewAccepted = preview !== null && fingerprint !== null && fingerprint === acceptedFingerprint;
  const remoteReady = previewAccepted && preview.executorCapability.ready;

  useEffect(() => {
    if (!open) return;
    const repository = repositories.find((item) => item.repositoryKey === repositoryKey) ?? repositories[0];
    if (!repository) return;
    setRepositoryKey(repository.repositoryKey);
    setDraft(initialGuardrailTargetDraft(repository));
    setExecutor(repository.defaultExecutor);
    setPreview(null);
    setAcceptedFingerprint(null);
    setIdempotencyKey(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!repositoryKey && repositories[0]) setRepositoryKey(repositories[0].repositoryKey);
  }, [repositories, repositoryKey]);

  function invalidatePreview(nextDraft?: GuardrailTargetDraft, nextExecutor?: GateExecutorKind) {
    if (nextDraft) setDraft(nextDraft);
    if (nextExecutor) setExecutor(nextExecutor);
    setPreview(null);
    setAcceptedFingerprint(null);
    setIdempotencyKey(null);
    setError(null);
  }

  function selectRepository(value: string) {
    const repository = repositories.find((item) => item.repositoryKey === value);
    if (!repository) return;
    setRepositoryKey(value);
    setDraft(initialGuardrailTargetDraft(repository));
    setExecutor(repository.defaultExecutor);
    setPreview(null);
    setAcceptedFingerprint(null);
    setIdempotencyKey(null);
    setError(null);
  }

  async function resolvePreview() {
    if (!selected || selected.source !== "github" || !target || !fingerprint) return;
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const response = await api.previewGuardrailTarget(selected.repositoryKey, { target, executor });
      setPreview(response.preview);
      setAcceptedFingerprint(fingerprint);
      setIdempotencyKey(`guardrail:${crypto.randomUUID()}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Falha ao resolver o alvo remoto";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!selected || !target) return;
    if (selected.source === "github" && (!previewAccepted || !preview?.executorCapability.ready)) return;
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const body = {
        repositoryKey: selected.repositoryKey,
        target,
        executor,
        ...(preview ? { previewIdentity: preview.previewIdentity } : {}),
      };
      const response = executor === "github-actions"
        ? await api.dispatchGuardrailActionsGate(
            selected.repositoryKey,
            body,
            idempotencyKey ?? `guardrail:${crypto.randomUUID()}`,
          )
        : await api.startGate(body);
      onOpenChange(false);
      onStarted(response.gate);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Falha ao iniciar o gate";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  const canStart = Boolean(selected && target) && (
    selected?.source === "local" || remoteReady
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button className="min-h-11" disabled={repositories.length === 0}>
          <GitPullRequestArrow aria-hidden size={14} />{t("guardrails.preflight")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 border-border bg-background sm:max-w-4xl">
        <SheetHeader className="border-b pr-14">
          <SheetTitle className="font-heading">{t("guardrails.preflightTitle")}</SheetTitle>
          <SheetDescription>{t("guardrails.preflightDescription")}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-5 p-4 pb-8">
            <section aria-labelledby="preflight-authority-title">
              <StepHeading code="01 / AUTHORITY" id="preflight-authority-title" title="Repositório e autoridade" />
              <Field label={t("guardrails.repository")} htmlFor="guardrail-preflight-repository">
                <Select value={selected?.repositoryKey ?? ""} onValueChange={selectRepository}>
                  <SelectTrigger id="guardrail-preflight-repository" className="min-h-11 w-full rounded-none"><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent position="popper" className="rounded-none border-border bg-popover">
                    {repositories.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey} className="min-h-11 rounded-none">{repository.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {selected && (
                <div className="mt-3 grid gap-3 border bg-secondary/20 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                  <span className="grid size-9 place-items-center border border-primary/50 text-primary">
                    {selected.source === "github" ? <GitBranch aria-hidden size={16} /> : <HardDrive aria-hidden size={16} />}
                  </span>
                  <div className="min-w-0">
                    <div className="bench-label text-primary">{selected.source === "github" ? "GITHUB APP" : "LOCAL WORKSPACE"}</div>
                    <div className="mt-1 break-all font-mono text-[10px]">{selected.source === "github" ? `${selected.remoteOwner}/${selected.remoteName}` : selected.repositoryPath}</div>
                  </div>
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">{selected.defaultBranch}</span>
                </div>
              )}
            </section>

            {selected && (
              <section aria-labelledby="preflight-target-title">
                <StepHeading code="02 / TARGET" id="preflight-target-title" title={selected.source === "github" ? t("guardrails.remoteTarget") : t("guardrails.localTarget")}>
                  {selected.source === "github" ? t("guardrails.remoteTargetHelp") : t("guardrails.localTargetHelp")}
                </StepHeading>

                {selected.source === "github" && (
                  <div className="mb-4 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Tipo de alvo remoto">
                    <ChoiceCard checked={draft.kind === "pull_request"} icon={<GitPullRequestArrow aria-hidden size={17} />} title={t("guardrails.pullRequest")} meta="PR NUMBER" description={t("guardrails.remoteTargetHelp")} onSelect={() => invalidatePreview({ ...draft, kind: "pull_request" })} />
                    <ChoiceCard checked={draft.kind === "compare"} icon={<GitCompareArrows aria-hidden size={17} />} title={t("guardrails.compareRefs")} meta="BASE + HEAD" description={t("guardrails.remoteTargetHelp")} onSelect={() => invalidatePreview({ ...draft, kind: "compare" })} />
                  </div>
                )}

                {selected.source === "github" && draft.kind === "pull_request" ? (
                  <Field label={t("guardrails.prNumber")} htmlFor="guardrail-pr-number" hint="Inteiro positivo, sem URL ou texto adicional.">
                    <Input id="guardrail-pr-number" inputMode="numeric" type="number" min={1} step={1} className="min-h-11 font-mono" value={draft.pullRequestNumber} onChange={(event) => invalidatePreview({ ...draft, pullRequestNumber: event.target.value })} />
                  </Field>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("guardrails.baseRef")} htmlFor="guardrail-base-ref" hint="Branch, tag ou SHA usada como autoridade da policy.">
                      <Input id="guardrail-base-ref" className="min-h-11 font-mono" value={draft.baseRef} onChange={(event) => invalidatePreview({ ...draft, baseRef: event.target.value })} />
                    </Field>
                    <Field label={t("guardrails.headRef")} htmlFor="guardrail-head-ref" hint={selected.source === "github" ? "Branch, tag ou SHA explícita." : "HEAD lê também o estado atual do workspace."}>
                      <Input id="guardrail-head-ref" className="min-h-11 font-mono" value={draft.headRef} onChange={(event) => invalidatePreview({ ...draft, headRef: event.target.value })} />
                    </Field>
                  </div>
                )}
              </section>
            )}

            {selected?.source === "github" && (
              <section aria-labelledby="preflight-executor-title">
                <StepHeading code="03 / EXECUTION PLANE" id="preflight-executor-title" title={t("guardrails.executorTitle")} />
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Executor do gate">
                  <ChoiceCard checked={executor === "sentinel-managed"} icon={<Cloud aria-hidden size={17} />} title="Sentinel managed" meta="IMMUTABLE SNAPSHOT" description={t("guardrails.managedDescription")} onSelect={() => invalidatePreview(undefined, "sentinel-managed")} />
                  <ChoiceCard checked={executor === "github-actions"} icon={<Workflow aria-hidden size={17} />} title="GitHub Actions" meta="PINNED CALLER" description={t("guardrails.actionsDescription")} onSelect={() => invalidatePreview(undefined, "github-actions")} />
                </div>
              </section>
            )}

            {selected?.source === "github" && (
              <section aria-labelledby="preflight-proof-title">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <StepHeading code="04 / SERVER PREVIEW" id="preflight-proof-title" title={t("guardrails.previewTitle")}>
                    {t("guardrails.previewDescription")}
                  </StepHeading>
                  <Button type="button" variant="outline" className="min-h-11" disabled={busy || !target} onClick={() => void resolvePreview()}>
                    <LockKeyhole aria-hidden size={14} />{busy ? t("guardrails.resolving") : previewAccepted ? t("guardrails.resolveAgain") : t("guardrails.resolve")}
                  </Button>
                </div>
                <div aria-live="polite">
                  {error && <AlertBanner>{error}</AlertBanner>}
                  {previewAccepted && preview ? <PreviewReadout preview={preview} /> : (
                    <div className="border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">{t("guardrails.previewEmpty")}</div>
                  )}
                </div>
              </section>
            )}
          </div>
        </ScrollArea>

        <div className="sticky bottom-0 mt-auto grid gap-3 border-t bg-background/95 p-4 backdrop-blur sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck aria-hidden size={14} className="mt-0.5 shrink-0 text-primary" />
            <span>{selected?.source === "github"
              ? previewAccepted && preview
                ? `${preview.resolvedTarget.baseSha.slice(0, 12)} → ${preview.resolvedTarget.headSha.slice(0, 12)} · ${preview.executor}`
                : t("guardrails.previewRequired")
              : "A identidade final do workspace será resolvida no início do gate."}</span>
          </div>
          <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={busy || !canStart} onClick={() => void start()}>
            <GitPullRequestArrow aria-hidden size={14} />{busy ? t("guardrails.starting") : executor === "github-actions" ? t("guardrails.dispatch") : t("guardrails.start")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PreviewReadout({ preview }: { preview: GuardrailTargetPreview }) {
  const capability = preview.executorCapability.ready ? "READY" : "BLOCKED";
  return (
    <div className="border">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3">
        <Readout label="Base ref / SHA" value={`${preview.resolvedTarget.baseRef}\n${preview.resolvedTarget.baseSha}`} />
        <Readout label="Head ref / SHA" value={`${preview.resolvedTarget.headRef}\n${preview.resolvedTarget.headSha}`} />
        <Readout label="Policy" value={`${preview.policySource} · ${preview.policySha}`} />
        <Readout label="Executor" value={`${capability} · ${preview.executorCapability.code}`} tone={preview.executorCapability.ready ? "good" : "risk"} />
        <Readout label="Scan intent" value={`${preview.scanPlan.model} · ${preview.scanPlan.effort} · ${preview.scanPlan.mode}\n${preview.scanPlan.scopeMode} · até ${preview.scanPlan.maxChangedPaths} paths`} />
        <Readout label="Envelope estimado" value={`≤ USD ${preview.costBudget.maxCostUsd.toFixed(2)}\nUma request em voo pode ultrapassar a estimativa.`} />
      </div>
      <div className="grid border-t px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div><div className="bench-label">PUBLICATION OWNER</div><p className="mt-1 text-xs text-muted-foreground">{preview.publication.eligible ? `Check elegível na branch protegida ${preview.publication.protectedBranch}.` : "Preflight fora da branch protegida: não publica aprovação."}</p></div>
        <span className="mt-2 font-mono text-[9px] uppercase text-primary sm:mt-0">EXPIRA {new Date(preview.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}

function Readout({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "risk" }) {
  return (
    <div className="min-w-0 border-b p-4 sm:border-r lg:[&:nth-child(3n)]:border-r-0">
      <div className="bench-label">{label}</div>
      <div className={`mt-2 whitespace-pre-wrap break-all font-mono text-[10px] leading-5 ${tone === "good" ? "text-chart-2" : tone === "risk" ? "text-destructive" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function StepHeading({ code, id, title, children }: { code: string; id?: string; title: string; children?: React.ReactNode }) {
  return <div className="mb-3"><div className="bench-label text-primary">{code}</div><h3 id={id} className="mt-1 font-heading text-base font-semibold">{title}</h3>{children && <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{children}</p>}</div>;
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label className="text-sm font-semibold" htmlFor={htmlFor}>{label}</label><div className="mt-2">{children}</div>{hint && <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}
