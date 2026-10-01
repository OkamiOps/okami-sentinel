import { useI18n } from "../../i18n";
import { useState } from "react";
import type { GateArtifact, GateRun, GuardrailPrCommentState } from "@csb/shared";
import { ExternalLink, MessageSquare, RotateCw, Send } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../../api";
import { useAuth } from "../../auth/AuthProvider";
import {
  commentStateLabelKey,
  commentUrl,
  gitHubRepositoryName,
  pullRequestUrl,
} from "../../lib/gate-publication";
import { prCheckLabel, publicationTarget } from "../../lib/github-guardrails";
import { isProtectedBranchBaselineRun } from "../../lib/guardrails";
import { AlertBanner, cx } from "../ui";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { GateOutcomeBadge } from "./GateOutcomeBadge";

export function PublishGateControl({
  gate,
  artifact,
  comment = null,
  onGateChange,
  onCommentChange,
}: {
  gate: GateRun;
  artifact: GateArtifact;
  comment?: GuardrailPrCommentState | null;
  onGateChange: (gate: GateRun) => void;
  onCommentChange?: (comment: GuardrailPrCommentState | null) => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const repositoryName = gitHubRepositoryName(artifact);
  const prUrl = pullRequestUrl(gate, repositoryName);
  const publishedCommentUrl = commentUrl(gate, comment, repositoryName);
  const target = publicationTarget(artifact);
  const configured = gate.publishStatus !== "not_configured";
  const canPublish = can("operator", gate.repositoryKey);
  const publishable = gate.status === "completed" && Boolean(artifact.repository.owner) && Boolean(target.headSha);
  const finished = gate.publishStatus === "published";
  const actionsOwned = gate.executor === "github-actions";

  async function publish() {
    setBusy(true);
    setActionError(null);
    try {
      const response = await api.publishGate(gate.id);
      onGateChange(response.gate);
      setConfirmOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("guardrails.publication.failed"));
      try {
        const response = await api.getGate(gate.id);
        onGateChange(response.gate);
      } catch {
        // Keep the last proven local decision visible when refresh also fails.
      }
    } finally {
      setBusy(false);
    }
  }

  async function republishComment() {
    setCommentBusy(true);
    setActionError(null);
    try {
      const response = await api.publishGateComment(gate.id);
      onCommentChange?.(response.comment);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("guardrails.comment.failed"));
    } finally {
      setCommentBusy(false);
    }
  }

  return (
    <section className="bench-panel min-w-0 overflow-hidden" aria-labelledby="publish-gate-title">
      <div className="grid min-w-0 lg:grid-cols-[minmax(14rem,.55fr)_minmax(0,1.45fr)_minmax(13rem,.55fr)]">
        <div className="border-b px-4 py-3 lg:border-b-0 lg:border-r">
          <div className="bench-label text-primary">PR CHECK / PUBLICATION</div>
          <h2 id="publish-gate-title" className="mt-1 font-heading text-sm font-semibold">{t("guardrails.publishTitle")}</h2>
          <div className="mt-3"><GateOutcomeBadge outcome={gate.outcome} status={gate.status} protectedBaseline={isProtectedBranchBaselineRun(gate, artifact)} /></div>
        </div>
        <div className="grid min-w-0 grid-cols-1 border-b sm:grid-cols-2 lg:border-b-0 lg:border-r">
          <Readout label="Owner / repo" value={target.repository} />
          <Readout label="Head SHA" value={target.headSha || t("guardrails.undetermined")} mono />
          <div className="border-t px-4 py-3 sm:col-span-2">
            <p className="text-xs leading-5 text-muted-foreground">{t("guardrails.publishDetail")}</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-between gap-3 px-4 py-3">
          <div>
            <div className="bench-label">{t("guardrails.checkState")}</div>
            <div className="mt-1 break-words font-mono text-[10px] font-semibold text-foreground">{prCheckLabel(gate)}</div>
            {gate.publishError && <p className="mt-2 break-words text-xs leading-5 text-destructive">{gate.publishError}</p>}
            {prUrl !== null && <>
              <div className="bench-label mt-3">{t("guardrails.commentState")}</div>
              <div className={cx(
                "mt-1 break-words font-mono text-[10px] font-semibold uppercase",
                comment?.status === "failed" ? "text-destructive" : "text-foreground",
              )} data-testid="gate-comment-state">
                {t(commentStateLabelKey(comment ?? null))}
              </div>
              {comment?.reason === "ambiguous_comment" && <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {t("guardrails.commentAmbiguous")}
              </p>}
            </>}
          </div>
          {actionsOwned ? (
            <div className="border border-info/35 bg-info/[.05] p-3">
              <div className="bench-label text-info">{t("guardrails.actionsOwned")}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("guardrails.actionsPublishDetail")}</p>
              {gate.workflowRunId && <div className="mt-2 break-all font-mono text-[9px] text-foreground">RUN {gate.workflowRunId}</div>}
            </div>
          ) : !configured ? (
            <Button asChild variant="configuration" className="min-h-11 w-full"><Link to={`/guardrails/setup?repository=${encodeURIComponent(gate.repositoryKey)}`}><ExternalLink aria-hidden size={14} />{t("guardrails.configureGithub")}</Link></Button>
          ) : finished ? (
            <Button variant="outline" className="min-h-11 w-full" disabled><Send aria-hidden size={14} />{t("guardrails.publication.published")}</Button>
          ) : canPublish ? (
            <Button className="min-h-11 w-full" disabled={busy || !publishable} onClick={() => setConfirmOpen(true)}>
              {gate.publishStatus === "failed" ? <RotateCw aria-hidden size={14} /> : <Send aria-hidden size={14} />}
              {busy || gate.publishStatus === "publishing" ? t("guardrails.publication.publishing") : gate.publishStatus === "failed" ? t("guardrails.publishRetry") : t("guardrails.publishCheck")}
            </Button>
          ) : null}

          {/* The pull request Sentinel already wrote in, and the comment it wrote
              there. Both are links out, so they never sit behind a confirmation. */}
          {prUrl !== null && <div className="grid gap-2">
            <Button asChild variant="outline" size="sm" className="min-h-11 w-full">
              <a href={prUrl} target="_blank" rel="noreferrer" data-testid="open-pull-request">
                <ExternalLink aria-hidden size={14} />{t("guardrails.openPullRequest")}
              </a>
            </Button>
            {publishedCommentUrl !== null && <Button asChild variant="outline" size="sm" className="min-h-11 w-full">
              <a href={publishedCommentUrl} target="_blank" rel="noreferrer" data-testid="open-published-comment">
                <MessageSquare aria-hidden size={14} />{t("guardrails.viewComment")}
              </a>
            </Button>}
            {canPublish && !actionsOwned && <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 w-full"
              disabled={commentBusy}
              data-testid="republish-comment"
              onClick={() => void republishComment()}
            >
              <RotateCw aria-hidden size={14} />{t("guardrails.republishComment")}
            </Button>}
          </div>}
        </div>
      </div>

      {actionError && <div className="border-t"><AlertBanner>{actionError}</AlertBanner></div>}

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="bottom" className="mx-auto max-h-[85dvh] overflow-y-auto border-border bg-background sm:left-1/2 sm:max-w-2xl sm:-translate-x-1/2">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-heading"><Send aria-hidden size={17} className="text-primary" />{t("guardrails.publishConfirmTitle")}</SheetTitle>
            <SheetDescription>{t("guardrails.publishConfirmDetail")}</SheetDescription>
          </SheetHeader>
          <div className="mx-4 grid border sm:grid-cols-2">
            <Readout label="Owner / repo" value={target.repository} />
            <Readout label="Head SHA" value={target.headSha || t("guardrails.undetermined")} mono />
          </div>
          <SheetFooter className="sm:flex-row sm:justify-end">
            <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => setConfirmOpen(false)}>{t("common.cancel")}</Button>
            <Button className="min-h-11" disabled={busy || !publishable} onClick={() => void publish()}><Send aria-hidden size={14} />{busy ? t("guardrails.publication.publishing") : t("guardrails.publishConfirm")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function Readout({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="bench-label">{label}</div>
      <div className={`mt-1 break-all text-xs ${mono ? "font-mono" : "font-medium"}`}>{value}</div>
    </div>
  );
}
