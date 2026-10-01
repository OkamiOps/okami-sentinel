import { useEffect, useState } from "react";
import { Check, Clipboard, Circle, GitPullRequestArrow, HelpCircle } from "lucide-react";

import { api, type GuardrailActionsStatus, type GuardrailCallerWorkflow } from "../../api";
import { AlertBanner, cx } from "../ui";
import { Button } from "@/components/ui/button";
import {
  callerWorkflowChecklist,
  type CallerWorkflowChecklistId,
} from "../../lib/github-action-form";
import type { GitHubT } from "./labels";
import type { GitHubActionsMessageKey } from "../../i18n/github-actions";

interface OpenedPullRequest {
  status: "created" | "exists";
  pullRequestNumber: number;
  pullRequestUrl: string;
  branch: string;
}

/**
 * What the GitHub Actions executor needs before it can run, and the one button that
 * installs it. Sentinel never writes to the default branch: the button opens a pull
 * request carrying the pinned caller, and the repository merges it like any other
 * change.
 *
 * The three prerequisites are not decoration. Two of them Sentinel reads from the
 * repository; the third — the `OPENAI_API_KEY` secret — it cannot, because it asks
 * for no grant to read secrets, so it is named in words and marked as the
 * operator's to confirm.
 */
export function CallerWorkflowPanel({
  repositoryKey,
  isAdmin,
  t,
}: {
  repositoryKey: string;
  isAdmin: boolean;
  t: GitHubT;
}) {
  const [workflow, setWorkflow] = useState<GuardrailCallerWorkflow | null>(null);
  const [status, setStatus] = useState<GuardrailActionsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState<OpenedPullRequest | null>(null);
  const [openError, setOpenError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void Promise.all([
      api.getGuardrailCallerWorkflow(repositoryKey),
      api.getGuardrailActionsStatus(repositoryKey),
    ]).then(([workflowResponse, statusResponse]) => {
      if (cancelled) return;
      setWorkflow(workflowResponse.workflow);
      setStatus(statusResponse.status);
    }).catch(() => {
      if (!cancelled) setLoadError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [repositoryKey]);

  async function copy() {
    if (workflow === null) return;
    await navigator.clipboard.writeText(workflow.content);
    setCopied(true);
  }

  async function openPullRequest() {
    setOpening(true);
    setOpenError(false);
    try {
      const response = await api.openGuardrailCallerWorkflowPullRequest(repositoryKey);
      setOpened(response.pullRequest);
      // The pull request changes what the repository will look like, not what it
      // looks like now: the checklist is re-read so a merged branch shows up without
      // reopening the sheet.
      const refreshed = await api.getGuardrailActionsStatus(repositoryKey);
      setStatus(refreshed.status);
    } catch {
      setOpenError(true);
    } finally {
      setOpening(false);
    }
  }

  const checklist = status === null ? [] : callerWorkflowChecklist(status);

  return <section className="border-t pt-5" data-testid="caller-workflow-panel">
    <div className="bench-label text-primary">{t("github.caller.section")}</div>
    <h3 className="mt-1 text-sm font-semibold">{t("github.caller.title")}</h3>
    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("github.caller.description")}</p>

    {loading && <p className="mt-3 text-xs text-muted-foreground">{t("github.caller.loading")}</p>}
    {loadError && <div className="mt-3"><AlertBanner>{t("github.caller.unavailable")}</AlertBanner></div>}

    {workflow !== null && <pre
      className="mt-3 max-h-56 overflow-auto border bg-muted/30 p-3 text-[10px] leading-4"
      aria-label={workflow.path}
    >{workflow.content}</pre>}

    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={workflow === null}
        onClick={() => void copy()}
      >
        <Clipboard aria-hidden size={14} />{copied ? t("github.caller.copied") : t("github.caller.copyYaml")}
      </Button>
      {isAdmin && <Button
        type="button"
        className="min-h-11"
        disabled={opening || workflow === null}
        onClick={() => void openPullRequest()}
      >
        <GitPullRequestArrow aria-hidden size={14} />
        {opening ? t("github.caller.opening") : t("github.caller.openPullRequest")}
      </Button>}
    </div>
    {!isAdmin && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("github.caller.adminOnly")}</p>}

    <div aria-live="polite">
      {openError && <div className="mt-3"><AlertBanner>{t("github.caller.openFailed")}</AlertBanner></div>}
      {opened !== null && <div className="mt-3 border border-primary/40 bg-primary/[.06] px-4 py-3 text-xs leading-5">
        <p>{t(
          opened.status === "created" ? "github.caller.openedCreated" : "github.caller.openedExists",
          { number: String(opened.pullRequestNumber), branch: opened.branch },
        )}</p>
        <a
          className="mt-1 inline-block underline"
          href={opened.pullRequestUrl}
          target="_blank"
          rel="noreferrer noopener"
        >{t("github.caller.viewPullRequest")}</a>
      </div>}
    </div>

    {status !== null && <div className="mt-5">
      <div className="bench-label">{t("github.caller.prerequisites")}</div>
      <ul className="mt-2 grid gap-2">
        {checklist.map((item) => <ChecklistRow key={item.id} id={item.id} ok={item.ok} t={t} />)}
      </ul>
    </div>}
  </section>;
}

function ChecklistRow({
  id,
  ok,
  t,
}: {
  id: CallerWorkflowChecklistId;
  ok: boolean;
  t: GitHubT;
}) {
  // `secret_present` is never `true` and is never wrong either: nobody can read it
  // from here. It gets its own neutral word instead of the red one a real gap earns.
  const unverifiable = id === "secret_present";
  const tone = ok ? "good" : unverifiable ? "neutral" : "risk";
  return <li className="border px-3 py-2">
    <div className="flex min-w-0 items-start gap-2">
      <span className={cx(
        "mt-0.5 shrink-0",
        tone === "good" && "text-primary",
        tone === "risk" && "text-destructive",
        tone === "neutral" && "text-muted-foreground",
      )} aria-hidden>
        {ok ? <Check size={14} /> : unverifiable ? <HelpCircle size={14} /> : <Circle size={14} />}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold">
          {t(`github.caller.check.${id}` as GitHubActionsMessageKey)}
        </p>
        <p className="bench-label mt-1">
          {t(ok
            ? "github.caller.state.ok"
            : unverifiable ? "github.caller.state.unverifiable" : "github.caller.state.pending")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t(`github.caller.hint.${id}` as GitHubActionsMessageKey)}
        </p>
      </div>
    </div>
  </li>;
}
