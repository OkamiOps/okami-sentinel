import type Database from "better-sqlite3";
import {
  NOTIFICATION_DEFAULTS,
  scanEstimatedUsd,
  type GateOutcome,
  type GateRun,
  type RepositoryNotificationEvent,
  type ScanRun,
  type SeverityCounts,
} from "@csb/shared";
import { getDb } from "../db.js";
import { enqueueEmail } from "./enqueue.js";
import { repositoryRecipients, type EmailRecipient } from "./recipients.js";
import { subscribedUserIds } from "./subscription-store.js";
import type { GateEmailData, ScanEmailData } from "./templates.js";

/**
 * The repository events: a gate that finished, a scan that stopped.
 *
 * Everything here is best effort by construction. A gate's decision and a scan's
 * status are the facts the product exists to produce; a notification about them
 * is not, and must never be able to fail, delay or roll back the write that
 * caused it. Hence: called *after* the persisted state change, wrapped, and
 * logged by code only.
 */

/** What a finished gate is called, or `null` when it is not an event at all. */
export function gateNotificationEvent(
  gate: Pick<GateRun, "status" | "outcome">,
): RepositoryNotificationEvent | null {
  // A cancellation is somebody's own decision; nobody needs an e-mail about it.
  if (gate.status === "cancelled" || gate.status === "cancelling") return null;
  if (gate.status === "error" || gate.outcome === "error") return "gate.error";
  if (gate.status !== "completed") return null;
  if (gate.outcome === "blocked") return "gate.blocked";
  // `pass`, `warning`, `no_changes` and `bootstrap` are all non-blocking
  // terminals. They share one subscription, which the design puts under
  // `gate.passed`; the body's `outcome` fact says which of the four it was.
  const passing: readonly GateOutcome[] = ["pass", "warning", "no_changes", "bootstrap"];
  return gate.outcome !== null && passing.includes(gate.outcome) ? "gate.passed" : null;
}

/** What a terminal scan status is called, or `null` when it is not an event. */
export function scanNotificationEvent(status: string): RepositoryNotificationEvent | null {
  if (status === "completed") return "scan.completed";
  // `incomplete` is a scan that stopped without a full result, which is what the
  // reader of `scan.failed` wants to hear about.
  if (status === "failed" || status === "incomplete") return "scan.failed";
  return null;
}

function repositoryDisplayName(
  repositoryKey: string | null,
  fallback: string,
  database: Database.Database,
): string {
  if (repositoryKey === null) return fallback;
  const row = database.prepare("SELECT display_name FROM guardrail_repositories WHERE repository_key = ?")
    .get(repositoryKey) as { display_name: string } | undefined;
  return row?.display_name ?? repositoryKey;
}

/** The linked scan's counts, read by column so no finding ever has to be loaded. */
function scanSeverity(scanId: string | null, database: Database.Database): SeverityCounts | null {
  if (scanId === null) return null;
  const row = database.prepare(`
    SELECT severity_critical AS critical, severity_high AS high, severity_medium AS medium,
           severity_low AS low, severity_info AS info, severity_unknown AS unknown,
           severity_total AS total
      FROM runs WHERE id = ?
  `).get(scanId) as SeverityCounts | undefined;
  return row ?? null;
}

function durationOf(startedAt: string | null, completedAt: string | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

interface NotifyOptions {
  database?: Database.Database;
  now?: Date;
  /** Only tests pass it; production reads `CSB_PUBLIC_ORIGIN`. */
  origin?: string | null;
  log?: (message: string) => void;
}

/**
 * Who receives one repository event: everybody who can see the repository right
 * now, minus whoever switched this event off, minus whoever has no address.
 *
 * A scan with no repository goes to administrators only, as the design says.
 * Those have no cell in anybody's matrix — the matrix is keyed by repository —
 * so the event's default is all there is to apply.
 */
export function repositoryEventRecipients(
  repositoryKey: string | null,
  event: RepositoryNotificationEvent,
  database: Database.Database,
): EmailRecipient[] {
  const candidates = repositoryRecipients(repositoryKey, database);
  if (repositoryKey === null) {
    return NOTIFICATION_DEFAULTS[event] ? candidates : [];
  }
  const wanted = new Set(
    subscribedUserIds(candidates.map((recipient) => recipient.userId), repositoryKey, event, database),
  );
  return candidates.filter((recipient) => wanted.has(recipient.userId));
}

/**
 * Queues one message per recipient. The dedupe key carries the recipient, so the
 * design's `gate.<gateId>.<event>` becomes one row each and a second observation
 * of the same terminal transition adds nothing.
 *
 * Wrapped in a transaction only when the caller is not already in one: a gate
 * completion is persisted before this runs, and a failure here must not take that
 * write with it.
 */
function queueForRecipients<K extends "gate.blocked" | "gate.error" | "gate.passed" | "scan.failed" | "scan.completed">(
  database: Database.Database,
  input: {
    event: K;
    scope: string | null;
    dedupePrefix: string;
    recipients: readonly EmailRecipient[];
    data: K extends "scan.failed" | "scan.completed" ? ScanEmailData : GateEmailData;
    now: Date;
    origin?: string | null;
  },
): number {
  let queued = 0;
  const write = (): void => {
    for (const recipient of input.recipients) {
      const result = enqueueEmail(database, {
        event: input.event,
        dedupeKey: `${input.dedupePrefix}.${recipient.userId}`,
        scope: input.scope,
        userId: recipient.userId,
        toAddress: recipient.toAddress,
        locale: recipient.locale,
        data: input.data,
        now: input.now,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      } as never);
      if (result.status === "queued") queued += 1;
    }
  };
  if (database.inTransaction) write();
  else database.transaction(write)();
  return queued;
}

/**
 * Notifies about a gate that reached a terminal status. Reads the *persisted*
 * row, never the in-flight value: a gate whose outcome never made it to the
 * database is a gate with no decision, and an e-mail about a decision that is not
 * stored would be the only record of it.
 */
export function notifyGateOutcome(gate: GateRun, options: NotifyOptions = {}): number {
  const database = options.database ?? getDb();
  const log = options.log ?? ((message: string) => console.warn(`[csb-api] ${message}`));
  try {
    const event = gateNotificationEvent(gate);
    if (event === null) return 0;
    const recipients = repositoryEventRecipients(gate.repositoryKey, event, database);
    if (recipients.length === 0) return 0;
    const data: GateEmailData = {
      gateId: gate.id,
      repository: repositoryDisplayName(gate.repositoryKey, gate.repositoryKey, database),
      branch: gate.headRef,
      pullRequest: gate.pullRequestNumber,
      outcome: gate.outcome ?? "error",
      severity: scanSeverity(gate.scanId, database),
      // A gate that never priced its scan reports `0`, which is not the same as
      // "it cost nothing" — a subscription scanner has no comparable price at all.
      costUsd: gate.estimatedUsd > 0 ? gate.estimatedUsd : null,
      durationMs: durationOf(gate.startedAt, gate.completedAt),
    };
    return queueForRecipients(database, {
      event,
      scope: gate.repositoryKey,
      dedupePrefix: `gate.${gate.id}.${event}`,
      recipients,
      data,
      now: options.now ?? new Date(),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    });
  } catch (error) {
    // The gate id and the kind of failure; never an address, a subject or a body.
    log(`Could not queue the ${gate.status} notification for gate ${gate.id}: ${failureKind(error)}`);
    return 0;
  }
}

/** The same, for a scan that reached a terminal status. */
export function notifyScanOutcome(run: ScanRun, options: NotifyOptions = {}): number {
  const database = options.database ?? getDb();
  const log = options.log ?? ((message: string) => console.warn(`[csb-api] ${message}`));
  try {
    const event = scanNotificationEvent(run.status);
    if (event === null) return 0;
    const repositoryKey = run.repositoryKey ?? null;
    const recipients = repositoryEventRecipients(repositoryKey, event, database);
    if (recipients.length === 0) return 0;
    const data: ScanEmailData = {
      scanId: run.id,
      repository: repositoryDisplayName(repositoryKey, run.displayName, database),
      branch: run.revision,
      status: run.status === "completed" ? "completed" : run.status === "incomplete" ? "incomplete" : "failed",
      severity: run.severity,
      costUsd: scanEstimatedUsd(run),
      durationMs: run.durationMs,
    };
    return queueForRecipients(database, {
      event,
      scope: repositoryKey,
      dedupePrefix: `scan.${run.id}.${event}`,
      recipients,
      data,
      now: options.now ?? new Date(),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    });
  } catch (error) {
    log(`Could not queue the ${run.status} notification for scan ${run.id}: ${failureKind(error)}`);
    return 0;
  }
}

/** A failure named by its kind. An exception's message belongs to whoever threw it. */
function failureKind(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
  const name = error instanceof Error ? error.name : "unknown_error";
  return typeof code === "string" && code !== "" ? `${name}/${code}` : name;
}
