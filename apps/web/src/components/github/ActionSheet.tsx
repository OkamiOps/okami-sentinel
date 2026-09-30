import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Workflow } from "lucide-react";
import type { GitHubAction, ProviderConnection, ProviderModel } from "@csb/shared";

import { AlertBanner, cx } from "../ui";
import { ChoiceCard } from "../guardrails/ChoiceCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  draftFromAction,
  initialGitHubActionDraft,
  validateGitHubActionDraft,
  type GitHubActionDraft,
  type GitHubActionFieldError,
  type GitHubActionRequestBody,
} from "../../lib/github-action-form";
import type { GitHubT } from "./labels";
import type { GitHubActionsMessageKey } from "../../i18n/github-actions";

/**
 * Create and edit in one side panel. Both executor cards are always rendered — a
 * radiogroup with one option is not a choice, and hiding GitHub Actions entirely
 * would leave the operator wondering whether it exists — but only `sentinel-managed`
 * is selectable in phase 1, and the other says "coming soon" out loud.
 */
export function ActionSheet({
  open,
  action,
  repositoryKey,
  connections,
  models,
  isAdmin,
  saving,
  submitError,
  t,
  onOpenChange,
  onSubmit,
  onConnectionChange,
}: {
  open: boolean;
  /** `null` creates; an action edits it. */
  action: GitHubAction | null;
  repositoryKey: string;
  connections: ProviderConnection[];
  models: ProviderModel[];
  isAdmin: boolean;
  saving: boolean;
  submitError: string | null;
  t: GitHubT;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: GitHubActionRequestBody) => void;
  onConnectionChange: (connectionId: string | null) => void;
}) {
  const [draft, setDraft] = useState<GitHubActionDraft>(() => initialGitHubActionDraft(repositoryKey));
  const [errors, setErrors] = useState<GitHubActionFieldError[]>([]);

  // Re-seeding on open is what keeps a cancelled edit from leaking into the next
  // one; the key is the action id so switching rows inside an open sheet reseeds too.
  useEffect(() => {
    if (!open) return;
    setDraft(action === null ? initialGitHubActionDraft(repositoryKey) : draftFromAction(action));
    setErrors([]);
  }, [open, action?.id, repositoryKey]);

  const readyConnections = useMemo(
    () => connections.filter((connection) => connection.status === "ready"),
    [connections],
  );
  const selectedConnection = readyConnections.find((connection) => connection.id === draft.connectionId) ?? null;
  const selectedModels = models.filter((model) => model.connectionId === selectedConnection?.id);
  const runtimeOnly = selectedConnection?.modelSelectionMode === "runtime-default";
  const errorFor = (field: GitHubActionFieldError["field"]): string | null => {
    const found = errors.find((error) => error.field === field);
    return found === undefined ? null : t(`github.error.${found.field}.${found.code}` as GitHubActionsMessageKey);
  };

  function update(patch: Partial<GitHubActionDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
  }

  function submit() {
    const result = validateGitHubActionDraft(draft, { isAdmin });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSubmit(result.body);
  }

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent className="w-full gap-0 overflow-y-auto border-border bg-background data-[side=right]:sm:max-w-[42rem]">
      <SheetHeader className="border-b pr-14">
        <SheetTitle className="font-heading">{action === null ? t("github.sheet.createTitle") : t("github.sheet.editTitle")}</SheetTitle>
        <SheetDescription>{action === null ? t("github.sheet.createDescription") : t("github.sheet.editDescription")}</SheetDescription>
      </SheetHeader>

      <form
        className="grid min-w-0 gap-5 p-4"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        {submitError && <AlertBanner>{submitError}</AlertBanner>}

        <Field label={t("github.sheet.name")} htmlFor="github-action-name" hint={t("github.sheet.nameHint")} error={errorFor("name")}>
          <Input
            id="github-action-name"
            value={draft.name}
            maxLength={120}
            aria-invalid={errorFor("name") !== null}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>

        <Field label={t("github.sheet.trigger")} htmlFor="github-action-trigger">
          <Select value={draft.triggerKind} onValueChange={(value) => update({ triggerKind: value as GitHubActionDraft["triggerKind"] })}>
            <SelectTrigger id="github-action-trigger" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" className="rounded-none border-border bg-popover">
              <SelectItem value="pull_request">{t("github.trigger.pull_request")}</SelectItem>
              <SelectItem value="push">{t("github.trigger.push")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label={t("github.sheet.branches")} htmlFor="github-action-branches" hint={t("github.sheet.branchesHint")} error={errorFor("branchPatterns")}>
          <Input
            id="github-action-branches"
            value={draft.branchPatterns}
            placeholder="main, release/**"
            aria-invalid={errorFor("branchPatterns") !== null}
            onChange={(event) => update({ branchPatterns: event.target.value })}
          />
        </Field>

        <section className="border-t pt-5">
          <div className="bench-label text-primary">{t("github.sheet.route")}</div>
          <h3 className="mt-1 text-sm font-semibold">{t("github.sheet.executorTitle")}</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("github.sheet.executorTitle")}>
            <ChoiceCard
              checked={draft.executor === "sentinel-managed"}
              icon={<ShieldCheck aria-hidden size={16} />}
              title={t("github.executor.sentinel-managed")}
              meta={t("github.sheet.engine")}
              description={t("github.executor.sentinelDescription")}
              onSelect={() => update({ executor: "sentinel-managed" })}
            />
            {/* Rendered and disabled, with the reason on it: GitHub Actions arrives
                in phase 4, and a card that simply vanished would read as a bug. */}
            <ChoiceCard
              checked={false}
              disabled
              icon={<Workflow aria-hidden size={16} />}
              title={t("github.executor.github-actions")}
              meta={t("github.executor.soon")}
              description={t("github.executor.actionsDescription")}
              onSelect={() => {}}
            />
          </div>
          {!isAdmin && <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("github.actions.adminOnlyField")}</p>}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={t("github.sheet.connection")} htmlFor="github-action-connection" error={errorFor("connectionId")}>
              <Select
                value={draft.connectionId ?? undefined}
                disabled={!isAdmin}
                onValueChange={(value) => { update({ connectionId: value, model: null }); onConnectionChange(value); }}
              >
                <SelectTrigger id="github-action-connection" className="w-full" aria-invalid={errorFor("connectionId") !== null}>
                  <SelectValue placeholder={t("github.sheet.connectionEmpty")} />
                </SelectTrigger>
                <SelectContent position="popper" className="rounded-none border-border bg-popover">
                  {readyConnections.map((connection) => <SelectItem key={connection.id} value={connection.id}>
                    {connection.name} · {connection.display.routeLabel}
                  </SelectItem>)}
                </SelectContent>
              </Select>
              {readyConnections.length === 0 && <p className="mt-2 text-xs text-destructive">{t("github.sheet.connectionMissing")}</p>}
            </Field>

            <Field label={t("github.sheet.model")} htmlFor="github-action-model">
              {runtimeOnly
                ? <Input id="github-action-model" value={t("github.sheet.modelRuntime")} readOnly aria-readonly="true" />
                : <Select
                  value={draft.model ?? "__runtime__"}
                  disabled={!isAdmin || selectedConnection === null}
                  onValueChange={(value) => update({ model: value === "__runtime__" ? null : value })}
                >
                  <SelectTrigger id="github-action-model" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" className="rounded-none border-border bg-popover">
                    <SelectItem value="__runtime__">{t("github.sheet.modelEmpty")}</SelectItem>
                    {selectedModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>}
            </Field>

            <Field label={t("github.sheet.mode")} htmlFor="github-action-mode">
              <Select value={draft.mode} disabled={!isAdmin} onValueChange={(value) => update({ mode: value as GitHubActionDraft["mode"] })}>
                <SelectTrigger id="github-action-mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent position="popper" className="rounded-none border-border bg-popover">
                  <SelectItem value="standard">{t("github.mode.standard")}</SelectItem>
                  <SelectItem value="deep">{t("github.mode.deep")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label={t("github.sheet.effort")} htmlFor="github-action-effort" hint={t("github.sheet.effortHint")}>
              <Input
                id="github-action-effort"
                value={draft.effort ?? ""}
                disabled={!isAdmin}
                placeholder={t("github.sheet.effortProvider")}
                onChange={(event) => update({ effort: event.target.value === "" ? null : event.target.value })}
              />
            </Field>
          </div>
        </section>

        <section className="border-t pt-5">
          <div className="bench-label text-primary">{t("github.sheet.budget")}</div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label={t("github.sheet.perScan")} htmlFor="github-action-cost" error={errorFor("costCeilingUsd")}>
              <Input
                id="github-action-cost"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                disabled={!isAdmin}
                value={draft.costCeilingUsd}
                aria-invalid={errorFor("costCeilingUsd") !== null}
                placeholder="2.00"
                onChange={(event) => update({ costCeilingUsd: event.target.value })}
              />
            </Field>
            <Field label={t("github.sheet.perDay")} htmlFor="github-action-daily" hint={t("github.sheet.perDayHint")} error={errorFor("dailyCostCeilingUsd")}>
              <Input
                id="github-action-daily"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                disabled={!isAdmin}
                value={draft.dailyCostCeilingUsd}
                aria-invalid={errorFor("dailyCostCeilingUsd") !== null}
                placeholder={draft.costCeilingUsd || "10.00"}
                onChange={(event) => update({ dailyCostCeilingUsd: event.target.value })}
              />
            </Field>
          </div>
        </section>

        <section className="border-t pt-5">
          <div className="bench-label text-primary">{t("github.sheet.state")}</div>
          <div className="mt-3 grid gap-3">
            <Toggle
              id="github-action-enabled"
              checked={draft.enabled}
              disabled={!isAdmin}
              label={t("github.sheet.enable")}
              onChange={(checked) => update({ enabled: checked })}
            />
            <Toggle
              id="github-action-forks"
              checked={draft.includeForks}
              disabled={!isAdmin}
              label={t("github.actions.includeForks")}
              onChange={(checked) => update({ includeForks: checked })}
            />
          </div>
          {errorFor("enabled") && <p role="alert" className="mt-2 text-xs text-destructive">{errorFor("enabled")}</p>}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("github.sheet.enableHint")}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("github.actions.includeForksHint")}</p>
        </section>

        <SheetFooter className="flex-row justify-end gap-2 px-0">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>{t("github.sheet.cancel")}</Button>
          <Button type="submit" className="min-h-11" disabled={saving}>{saving ? t("github.sheet.saving") : t("github.sheet.save")}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
  </Sheet>;
}

function Field({
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
  return <div className="min-w-0">
    <label className="text-xs font-semibold" htmlFor={htmlFor}>{label}</label>
    <div className="mt-2">{children}</div>
    {/* The message sits under its own control, so a form with three problems shows
        three of them instead of one banner that names none. */}
    {error && <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">{error}</p>}
    {!error && hint && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
  </div>;
}

function Toggle({
  id,
  checked,
  disabled,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return <label
    htmlFor={id}
    className={cx(
      "flex min-h-11 min-w-0 cursor-pointer items-center gap-3 border px-3 py-2 text-xs",
      disabled && "cursor-not-allowed opacity-60",
    )}
  >
    <input
      id={id}
      type="checkbox"
      className="size-4 shrink-0 accent-primary"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className="min-w-0 break-words">{label}</span>
  </label>;
}
