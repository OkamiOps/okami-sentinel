import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, GitBranch } from "lucide-react";
import type { GitHubAction, GitHubActionEvent, GitHubActionEventStatus, GuardrailRepository } from "@csb/shared";

import { EmptyState, Panel, cx } from "../ui";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate, formatUsd, shortId } from "../../format";
import { eventStatusTone, isNeutralReason, reasonText, type GitHubT } from "./labels";

const OUTCOMES: readonly GitHubActionEventStatus[] = [
  "observed", "queued", "dispatching", "launched", "skipped", "failed", "superseded",
];

/**
 * `03 ATIVIDADE`. One row per received event: what arrived, which action matched,
 * which gate was born, or — in words — why it was ignored.
 */
export function ActivityList({
  events,
  actions,
  repositories,
  repositoryKey,
  outcome,
  hasMore,
  loading,
  t,
  repositoryHref,
  outcomeHref,
  onLoadMore,
}: {
  events: GitHubActionEvent[];
  /** Already loaded by the page; the row needs the matched action's name. */
  actions: GitHubAction[];
  repositories: GuardrailRepository[];
  repositoryKey: string;
  outcome: GitHubActionEventStatus | "";
  hasMore: boolean;
  loading: boolean;
  t: GitHubT;
  repositoryHref: (repositoryKey: string) => string;
  outcomeHref: (outcome: string) => string;
  onLoadMore: () => void;
}) {
  const navigate = useNavigate();
  return <Panel label={t("github.activity")} title={t("github.activityTitle")} wrapTitle>
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("github.activityDescription")}</p>

    <div className="grid gap-3 border-b p-4 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,.5fr)_minmax(11rem,.35fr)]">
      <Field label={t("github.actions.repository")} htmlFor="github-activity-repository">
        <Select
          value={repositoryKey || "__all__"}
          onValueChange={(value) => navigate(repositoryHref(value === "__all__" ? "" : value))}
        >
          <SelectTrigger id="github-activity-repository" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" className="rounded-none border-border bg-popover">
            <SelectItem value="__all__">{t("github.actions.allRepositories")}</SelectItem>
            {repositories.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey}>{repository.displayName}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("github.activity.filterOutcome")} htmlFor="github-activity-outcome">
        <Select
          value={outcome || "__all__"}
          onValueChange={(value) => navigate(outcomeHref(value === "__all__" ? "" : value))}
        >
          <SelectTrigger id="github-activity-outcome" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" className="rounded-none border-border bg-popover">
            <SelectItem value="__all__">{t("github.activity.allOutcomes")}</SelectItem>
            {OUTCOMES.map((value) => <SelectItem key={value} value={value}>{t(`github.status.${value}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
    </div>

    {events.length === 0
      ? <EmptyState title={t("github.activity.empty")} description={t("github.activity.emptyDescription")} />
      : <ul className="divide-y">
        {events.map((event) => <li key={event.id}>
          <ActivityRow
            event={event}
            actionName={actions.find((action) => action.id === event.actionId)?.name ?? null}
            t={t}
          />
        </li>)}
      </ul>}

    {hasMore && <div className="border-t p-4">
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onLoadMore}>
        {loading ? t("github.activity.loadingMore") : t("github.activity.loadMore")}
      </Button>
    </div>}
  </Panel>;
}

export function ActivityRow({
  event,
  actionName,
  t,
}: {
  event: GitHubActionEvent;
  /** `null` when the action was deleted; the id still identifies the row. */
  actionName: string | null;
  t: GitHubT;
}) {
  const gateUrl = event.gateId ? `/guardrails/${encodeURIComponent(event.gateId)}` : null;
  // A failure shows what failed; anything else shows why nothing happened, and both
  // are sentences.
  const reason = reasonText(t, event.error ?? event.reason);
  const failed = event.error !== null || event.status === "failed";
  const neutral = !failed && isNeutralReason(event.error ?? event.reason);

  return <article className="grid min-w-0 gap-3 px-4 py-4 lg:grid-cols-[9.5rem_minmax(0,1fr)_auto] lg:items-start">
    <div className="min-w-0">
      <span className={cx("inline-flex border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", eventStatusTone[event.status])}>
        {t(`github.status.${event.status}`)}
      </span>
      <div className="mt-2 font-mono text-[9px] text-muted-foreground">{formatDate(event.detectedAt)}</div>
      <div className="mt-1 font-mono text-[8px] uppercase tracking-wider text-muted-foreground">{t(`github.activity.origin.${event.origin}`)}</div>
    </div>

    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <GitBranch aria-hidden className="size-3 shrink-0 text-primary" />
        <strong className="min-w-0 break-words text-sm">
          {t(`github.trigger.${event.kind}`)}{event.pullRequestNumber ? ` #${event.pullRequestNumber}` : ""}
        </strong>
        <span className="min-w-0 break-all font-mono text-[9px] text-muted-foreground">{event.repositoryKey}</span>
      </div>
      <div className="mt-1 min-w-0 break-all font-mono text-[10px] text-muted-foreground">
        {event.headRef || t("github.activity.unknownRef")} · {t("github.activity.head")} {shortId(event.headSha)}
        {event.baseRef ? ` · ${event.baseRef}` : ""}
        {/* The delivery id is what correlates a row with Entregas and with GitHub's
            own Recent Deliveries; without it the two lists cannot be joined. */}
        {event.deliveryId !== null ? ` · ${shortId(event.deliveryId)}` : ""}
      </div>
      {/* Several actions may now share a repository, so two rows of one push differ
          only by which action matched. Naming it is the question this list exists
          to answer. */}
      <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
        <span className="bench-label">{t("github.actions.column.name")}</span>
        <span className="min-w-0 break-words font-mono text-[10px]">
          {actionName ?? shortId(event.actionId)}
        </span>
      </div>
      {event.title && <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">{event.title}</p>}
      {reason && <p className={cx(
        "mt-2 min-w-0 break-words text-xs leading-relaxed",
        failed ? "text-destructive" : neutral ? "text-muted-foreground" : "text-chart-3",
      )}>
        <span className="bench-label mr-1.5 inline">{t("github.activity.reason")}</span>{reason}
      </p>}
    </div>

    <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
      {event.costCeilingUsd !== null && <span className="inline-flex min-w-0 items-baseline gap-1.5">
        <span className="bench-label">{t("github.activity.ceiling")}</span>
        <span className="font-mono text-[10px] text-primary">{formatUsd(event.costCeilingUsd, true)}</span>
      </span>}
      {gateUrl && <Button asChild variant="outline" size="sm">
        <Link to={gateUrl}>{t("github.activity.openGate")}<ArrowUpRight aria-hidden className="size-3" /></Link>
      </Button>}
    </div>
  </article>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return <div className="min-w-0">
    <label className="bench-label" htmlFor={htmlFor}>{label}</label>
    <div className="mt-2">{children}</div>
  </div>;
}
