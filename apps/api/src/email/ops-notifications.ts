import type Database from "better-sqlite3";
import {
  connectionNeedsAttention,
  OPS_NOTIFICATION_SCOPE,
  type ConnectionStatus,
  type OpsNotificationEvent,
  type ScannerCatalogResponse,
} from "@csb/shared";
import { listConnections } from "../connections-store.js";
import { getDb } from "../db.js";
import { getGateRun } from "../gate-store.js";
import { listGitHubMonitorRules, reservedGitHubMonitorCostForUtcDay } from "../github-monitor/store.js";
import { getScannerCatalog } from "../scanners/catalog.js";
import { enqueueEmail } from "./enqueue.js";
import {
  deleteOpsAlertState,
  getOpsAlertState,
  listUnresolvedOpsAlerts,
  putOpsAlertState,
  type OpsAlertState,
} from "./ops-alert-store.js";
import { adminRecipients, type EmailRecipient } from "./recipients.js";
import { subscribedUserIds } from "./subscription-store.js";
import type { EmailMessageDataMap } from "./templates.js";

/**
 * The operational alerts, and the small periodic evaluator that finds them.
 *
 * Three of the four are *conditions* rather than events: the engine is down, a
 * connection is broken, a check never reached GitHub. A condition has no moment
 * to hook, so it is sampled — every sixty seconds — and the design's noise
 * control is applied to the sample: nothing for the first five minutes of an
 * engine outage, at most one message per `(event, target)` per six hours while it
 * lasts, and one message when it ends. The fourth, the daily cost ceiling, is a
 * crossing, and its once-per-day-per-ceiling guarantee is the outbox's unique
 * `dedupe_key` rather than a window.
 */

/** How often the evaluator looks. Cheap: four indexed reads and one CLI probe. */
export const OPS_EVALUATOR_INTERVAL_MS = 60_000;
/** The design's window: one alert per condition per six hours while it persists. */
export const OPS_ALERT_REPEAT_MS = 6 * 3_600_000;
/** "mais de 5 min": an engine that blinks is not an outage. */
export const OPS_ENGINE_GRACE_MS = 5 * 60_000;
/** The only target an engine outage can have; there is one engine per installation. */
export const OPS_ENGINE_TARGET = "engine";
/** The two crossings of a daily ceiling the design asks for. */
export const OPS_DAILY_COST_THRESHOLDS: readonly number[] = Object.freeze([80, 100]);

/** Who hears about operational alerts: administrators who did not switch them off. */
export function opsRecipients(
  event: OpsNotificationEvent,
  database: Database.Database,
): EmailRecipient[] {
  const admins = adminRecipients(database);
  const wanted = new Set(
    subscribedUserIds(admins.map((admin) => admin.userId), OPS_NOTIFICATION_SCOPE, event, database),
  );
  return admins.filter((admin) => wanted.has(admin.userId));
}

type OpsMessageKind = keyof EmailMessageDataMap & (`ops.${string}`);

/**
 * Queues one operational message per administrator. The scope is `ops`, so the
 * worker cancels a row whose recipient stopped being an administrator while it
 * waited in the queue.
 */
function queueOps<K extends OpsMessageKind>(
  database: Database.Database,
  input: {
    event: OpsNotificationEvent;
    kind: K;
    dedupeKey: string;
    data: EmailMessageDataMap[K];
    now: Date;
    origin?: string | null;
  },
): number {
  let queued = 0;
  for (const recipient of opsRecipients(input.event, database)) {
    const result = enqueueEmail(database, {
      event: input.kind,
      dedupeKey: `${input.dedupeKey}.${recipient.userId}`,
      scope: OPS_NOTIFICATION_SCOPE,
      userId: recipient.userId,
      toAddress: recipient.toAddress,
      locale: recipient.locale,
      data: input.data,
      now: input.now,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    } as never);
    if (result.status === "queued") queued += 1;
  }
  return queued;
}

export type OpsConditionOutcome = "alerted" | "resolved" | null;

export interface OpsConditionInput {
  event: OpsNotificationEvent;
  target: string;
  active: boolean;
  now: Date;
  /** How long the condition has to persist before the first alert. */
  graceMs?: number;
  /** Queues the alert. Called inside the transaction that records it. */
  alert: (activeSince: Date) => void;
  /** Queues the "it is over" message. Only called if an alert ever went out. */
  resolve: (activeSince: Date) => void;
}

/**
 * One sample of one condition, with the window and the grace period applied.
 *
 * The send and the state write happen in one transaction: if the enqueue fails,
 * `last_sent_at` is not advanced and the next sample, a minute later, tries again.
 * The reverse order would silently swallow an alert.
 */
export function stepOpsCondition(
  database: Database.Database,
  input: OpsConditionInput,
): OpsConditionOutcome {
  const { event, target, now } = input;
  const graceMs = input.graceMs ?? 0;
  const state = getOpsAlertState(event, target, database);
  const ongoing = state !== null && state.resolvedAt === null;

  if (input.active) {
    // A new episode starts now; an ongoing one keeps the stamp it already had, so
    // a restart does not reset either the grace period or the six-hour window.
    const activeSince = ongoing ? new Date(state.activeSince) : now;
    if (!ongoing) {
      putOpsAlertState({
        event, target, activeSince: activeSince.toISOString(), lastSentAt: null, resolvedAt: null,
      }, database);
    }
    if (now.getTime() - activeSince.getTime() < graceMs) return null;
    const lastSentAt = ongoing ? state.lastSentAt : null;
    if (lastSentAt !== null && now.getTime() - Date.parse(lastSentAt) < OPS_ALERT_REPEAT_MS) return null;
    database.transaction(() => {
      input.alert(activeSince);
      putOpsAlertState({
        event, target, activeSince: activeSince.toISOString(),
        lastSentAt: now.toISOString(), resolvedAt: null,
      }, database);
    })();
    return "alerted";
  }

  if (!ongoing) return null;
  if (state.lastSentAt === null) {
    // Started and ended inside the grace period: nobody was told, so there is
    // nothing to tell them is over.
    deleteOpsAlertState(event, target, database);
    return null;
  }
  const activeSince = new Date(state.activeSince);
  database.transaction(() => {
    input.resolve(activeSince);
    putOpsAlertState({ ...state, resolvedAt: now.toISOString() }, database);
  })();
  return "resolved";
}

export interface OpsEvaluatorOptions {
  database?: Database.Database;
  now?: Date;
  origin?: string | null;
  /**
   * The scanner catalogue. Injected only by tests: the real one shells out to the
   * scanner binaries, which a unit test neither has nor should depend on.
   */
  catalog?: () => Promise<ScannerCatalogResponse>;
}

// --------------------------------------------------------------------------
// The engine
// --------------------------------------------------------------------------

export interface EngineAvailability {
  available: boolean;
  /** The engine ids that cannot run, named without naming the host. */
  unavailable: string[];
}

/**
 * Whether this installation can start a scan at all.
 *
 * Two routes count, because two exist: a local scanner the host can run — the
 * same probe `/health` and the shell's ENGINE READY reflect — or a provider
 * connection the server can reach. A deployment that only ever scans over HTTP
 * has no local CLI and must not be reported as permanently broken.
 */
export async function engineAvailability(
  database: Database.Database = getDb(),
  probe: () => Promise<ScannerCatalogResponse> = getScannerCatalog,
): Promise<EngineAvailability> {
  const catalog = await probe();
  const enabled = catalog.scanners.filter((scanner) => scanner.enabled);
  const unavailable = enabled.filter((scanner) => !scanner.available).map((scanner) => scanner.engine);
  if (enabled.some((scanner) => scanner.available)) return { available: true, unavailable: [] };
  const routed = listConnections(database).some((connection) => connection.status === "ready");
  return { available: routed, unavailable: routed ? [] : unavailable };
}

export async function evaluateEngineAvailability(
  options: OpsEvaluatorOptions = {},
): Promise<OpsConditionOutcome> {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const { available, unavailable } = await engineAvailability(database, options.catalog ?? getScannerCatalog);
  return stepOpsCondition(database, {
    event: "ops.engine_unavailable",
    target: OPS_ENGINE_TARGET,
    active: !available,
    now,
    graceMs: OPS_ENGINE_GRACE_MS,
    alert: (activeSince) => {
      queueOps(database, {
        event: "ops.engine_unavailable",
        kind: "ops.engine_unavailable",
        dedupeKey: `ops.engine_unavailable.${OPS_ENGINE_TARGET}.${now.toISOString()}`,
        data: { since: activeSince, at: now, engines: unavailable },
        now,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    },
    resolve: (activeSince) => {
      queueOps(database, {
        event: "ops.engine_unavailable",
        kind: "ops.engine_unavailable.resolved",
        dedupeKey: `ops.engine_unavailable.${OPS_ENGINE_TARGET}.resolved.${activeSince.toISOString()}`,
        data: { since: activeSince, at: now },
        now,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    },
  });
}

// --------------------------------------------------------------------------
// Provider connections
// --------------------------------------------------------------------------

export function evaluateConnectionAttention(options: OpsEvaluatorOptions = {}): OpsConditionOutcome[] {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const connections = new Map(
    listConnections(database).map((connection) => [connection.id, connection]),
  );
  // Every connection that is broken now, plus every one this installation was
  // already watching: a connection that went back to ready — or was deleted —
  // disappears from the first list, and only the second knows it was ever broken.
  const targets = new Set<string>([
    ...connections.keys(),
    ...listUnresolvedOpsAlerts("ops.connection_attention", database).map((state) => state.target),
  ]);
  const outcomes: OpsConditionOutcome[] = [];
  for (const target of [...targets].sort()) {
    const connection = connections.get(target);
    const active = connection !== undefined && connectionNeedsAttention(connection.status);
    const name = connection?.name ?? target;
    const status: ConnectionStatus = connection?.status ?? "unavailable";
    outcomes.push(stepOpsCondition(database, {
      event: "ops.connection_attention",
      target,
      active,
      now,
      alert: (activeSince) => {
        queueOps(database, {
          event: "ops.connection_attention",
          kind: "ops.connection_attention",
          dedupeKey: `ops.connection_attention.${target}.${now.toISOString()}`,
          data: { connectionName: name, status, since: activeSince, at: now },
          now,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        });
      },
      resolve: (activeSince) => {
        queueOps(database, {
          event: "ops.connection_attention",
          kind: "ops.connection_attention.resolved",
          dedupeKey: `ops.connection_attention.${target}.resolved.${activeSince.toISOString()}`,
          data: { connectionName: name, since: activeSince, at: now },
          now,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        });
      },
    }));
  }
  return outcomes;
}

// --------------------------------------------------------------------------
// The daily cost ceiling
// --------------------------------------------------------------------------

/** The UTC day a reservation belongs to, the same boundary the monitor reserves on. */
export function utcDayBounds(now: Date): { day: string; start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    day: start.toISOString().slice(0, 10),
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

/**
 * The crossings, not the level: one message per `(rule, threshold, UTC day)`,
 * enforced by the outbox's unique key rather than by a timer, so a restart cannot
 * produce a second one and a new day starts clean.
 *
 * Only the highest threshold crossed is sent. A jump straight past both would
 * otherwise deliver "you are at 80%" next to "you are at 100%", and the first one
 * says less about the same fact.
 */
export function evaluateDailyCost(options: OpsEvaluatorOptions = {}): number {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const { day, start, end } = utcDayBounds(now);
  let queued = 0;
  for (const rule of listGitHubMonitorRules(null, database)) {
    if (!rule.enabled) continue;
    const ceiling = rule.dailyCostCeilingUsd ?? rule.costCeilingUsd;
    if (ceiling === null || ceiling <= 0) continue;
    const reserved = reservedGitHubMonitorCostForUtcDay(rule.id, start, end, database);
    const share = (reserved / ceiling) * 100;
    const crossed = [...OPS_DAILY_COST_THRESHOLDS].reverse().find((threshold) => share >= threshold);
    if (crossed === undefined) continue;
    queued += queueOps(database, {
      event: "ops.daily_cost",
      kind: "ops.daily_cost",
      dedupeKey: `ops.daily_cost.${rule.id}.${day}.${crossed}`,
      data: {
        repository: rule.repositoryKey,
        day,
        percent: crossed === 100 ? 100 : 80,
        reservedUsd: reserved,
        ceilingUsd: ceiling,
      },
      now,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    });
  }
  return queued;
}

// --------------------------------------------------------------------------
// A GitHub check that never arrived
// --------------------------------------------------------------------------

function publishCondition(
  database: Database.Database,
  input: { gateId: string; active: boolean; now: Date; origin?: string | null },
): OpsConditionOutcome {
  const gate = getGateRun(input.gateId, database);
  const repository = gate === null
    ? input.gateId
    : repositoryLabel(gate.repositoryKey, database);
  return stepOpsCondition(database, {
    event: "ops.github_publish_failed",
    target: input.gateId,
    active: input.active,
    now: input.now,
    alert: (activeSince) => {
      void activeSince;
      queueOps(database, {
        event: "ops.github_publish_failed",
        kind: "ops.github_publish_failed",
        dedupeKey: `ops.github_publish_failed.${input.gateId}.${input.now.toISOString()}`,
        data: {
          gateId: input.gateId,
          repository,
          branch: gate?.headRef ?? "-",
          // A code or a provider message, capped: an operational alert names the
          // failure, it does not carry a transcript.
          reason: (gate?.publishError ?? "github_check_publish_failed").slice(0, 200),
          at: input.now,
        },
        now: input.now,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      });
    },
    resolve: (activeSince) => {
      queueOps(database, {
        event: "ops.github_publish_failed",
        kind: "ops.github_publish_failed.resolved",
        dedupeKey: `ops.github_publish_failed.${input.gateId}.resolved.${activeSince.toISOString()}`,
        data: { gateId: input.gateId, repository, since: activeSince, at: input.now },
        now: input.now,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      });
    },
  });
}

function repositoryLabel(repositoryKey: string, database: Database.Database): string {
  const row = database.prepare("SELECT display_name FROM guardrail_repositories WHERE repository_key = ?")
    .get(repositoryKey) as { display_name: string } | undefined;
  return row?.display_name ?? repositoryKey;
}

/**
 * Called where `publish_status` becomes `failed`, after the row is written.
 *
 * Hooked rather than polled so the alert is immediate and, just as importantly,
 * so shipping this feature does not alert about every gate that failed to publish
 * before the table existed: only a gate the hook has seen gets a state row, and
 * only a state row is ever re-examined.
 *
 * Swallows everything. A publish that already failed must not fail twice.
 */
export function notifyGitHubPublishFailed(
  gateId: string,
  options: OpsEvaluatorOptions & { log?: (message: string) => void } = {},
): OpsConditionOutcome {
  const database = options.database ?? getDb();
  const log = options.log ?? ((message: string) => console.warn(`[csb-api] ${message}`));
  try {
    return publishCondition(database, {
      gateId,
      active: true,
      now: options.now ?? new Date(),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    });
  } catch (error) {
    log(`Could not queue the publish-failure alert for gate ${gateId}: ${failureKind(error)}`);
    return null;
  }
}

/** Closes the alerts whose gate has since published — or stopped existing. */
export function evaluatePublishRecovery(options: OpsEvaluatorOptions = {}): OpsConditionOutcome[] {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  return listUnresolvedOpsAlerts("ops.github_publish_failed", database).map((state) => {
    const gate = getGateRun(state.target, database);
    return publishCondition(database, {
      gateId: state.target,
      active: gate !== null && gate.publishStatus === "failed",
      now,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    });
  });
}

// --------------------------------------------------------------------------
// The loop
// --------------------------------------------------------------------------

export interface OpsEvaluatorTick {
  engine: OpsConditionOutcome;
  connections: OpsConditionOutcome[];
  publish: OpsConditionOutcome[];
  dailyCost: number;
}

/**
 * One pass over all four conditions. Each is independent and each is wrapped: a
 * scanner probe that hangs must not stop the cost ceiling from being noticed.
 */
export async function runOpsEvaluatorTick(
  options: OpsEvaluatorOptions & { log?: (message: string) => void } = {},
): Promise<OpsEvaluatorTick> {
  const log = options.log ?? ((message: string) => console.warn(`[csb-api] ${message}`));
  const tick: OpsEvaluatorTick = { engine: null, connections: [], publish: [], dailyCost: 0 };
  try {
    tick.engine = await evaluateEngineAvailability(options);
  } catch (error) {
    log(`Operational evaluation of the engine failed: ${failureKind(error)}`);
  }
  try {
    tick.connections = evaluateConnectionAttention(options);
  } catch (error) {
    log(`Operational evaluation of the connections failed: ${failureKind(error)}`);
  }
  try {
    tick.publish = evaluatePublishRecovery(options);
  } catch (error) {
    log(`Operational evaluation of the GitHub publications failed: ${failureKind(error)}`);
  }
  try {
    tick.dailyCost = evaluateDailyCost(options);
  } catch (error) {
    log(`Operational evaluation of the daily cost ceilings failed: ${failureKind(error)}`);
  }
  return tick;
}

export interface OpsEvaluatorHandle {
  stop(): Promise<void>;
  /** For tests: runs one pass now, respecting the no-overlap rule. */
  tick(): Promise<OpsEvaluatorTick | null>;
}

/**
 * The in-process loop, started next to the outbox worker and guarded the same
 * way: `running` is the overlap guard and is cleared by a `finally` that cannot
 * run before the promise was stored, because it is not the promise's own.
 */
export function startOpsEvaluator(
  options: OpsEvaluatorOptions & { log?: (message: string) => void; intervalMs?: number } = {},
): OpsEvaluatorHandle {
  const log = options.log ?? ((message: string) => console.warn(`[csb-api] ${message}`));
  let stopped = false;
  let running = false;
  let inFlight: Promise<OpsEvaluatorTick | null> | null = null;

  const tick = async (): Promise<OpsEvaluatorTick | null> => {
    if (stopped || running) return null;
    running = true;
    const run = (async (): Promise<OpsEvaluatorTick | null> => {
      try {
        return await runOpsEvaluatorTick({ ...options, log });
      } catch (error) {
        if (!stopped) log(`Operational evaluator tick failed: ${failureKind(error)}`);
        return null;
      } finally {
        running = false;
      }
    })();
    inFlight = run;
    void run.then(() => { if (inFlight === run) inFlight = null; });
    return run;
  };

  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? OPS_EVALUATOR_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
    },
    tick,
  };
}

/** A failure named by its kind; an exception's message belongs to whoever threw it. */
function failureKind(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
  const name = error instanceof Error ? error.name : "unknown_error";
  return typeof code === "string" && code !== "" ? `${name}/${code}` : name;
}
