import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const RECOVERABLE = new Set([
  "agent_turn_limit", "agent_tool_limit", "agent_input_byte_limit",
  "agent_output_byte_limit", "agent_context_limit", "agent_context_token_limit",
  "stage_artifact_invalid", "agent_artifact_stalled",
]);

export interface PortableStageRecoveryEvent {
  stage: string;
  page: string;
  attempt: number;
  priorErrorCode: string;
}

export class PortableStageRecoveryError extends Error {
  constructor(
    readonly code: "stage_recovery_exhausted" | "stage_recovery_state_invalid" | "stage_recovery_busy",
    readonly attempts: number,
    readonly lastErrorCode?: string,
  ) { super(code); this.name = "PortableStageRecoveryError"; }
}

export interface PortableStageRecoveryOptions<T> {
  /** Runner-owned metadata directory, never the exact stage artifact directory. */
  metadataDir: string;
  snapshotId: string;
  stage: string;
  page: string;
  /** At most two additional sessions. Counters survive subsequent invocations. */
  maxRetries?: number;
  signal?: AbortSignal;
  run: (attempt: number, priorErrorCode: string | undefined) => Promise<T>;
  /** Must perform the same strict snapshot, membership and anchor checks as normal completion. */
  recoverCheckpoint?: () => Promise<T | undefined>;
  onRecovery?: (event: PortableStageRecoveryEvent) => void;
}

interface RecoveryState {
  version: 1;
  snapshotId: string;
  stage: string;
  page: string;
  attempts: number;
  lastErrorCode?: string;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" && RECOVERABLE.has(error.code) ? error.code : undefined;
}

/** Each run callback must construct a fresh session; this helper never retries a live session. */
export async function runPortableStageWithRecovery<T>(options: PortableStageRecoveryOptions<T>): Promise<T> {
  const retries = options.maxRetries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2 ||
      !options.snapshotId || !options.stage || !options.page) {
    throw new PortableStageRecoveryError("stage_recovery_state_invalid", 0);
  }
  options.signal?.throwIfAborted();
  fs.mkdirSync(options.metadataDir, { recursive: true, mode: 0o700 });
  const identity = { snapshotId: options.snapshotId, stage: options.stage, page: options.page };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const file = path.join(options.metadataDir, `${key}.json`);
  const lock = path.join(options.metadataDir, `${key}.lock`);
  let descriptor: number;
  try { descriptor = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PortableStageRecoveryError("stage_recovery_busy", 0);
    throw error;
  }
  try {
    let state: RecoveryState = { version: 1, ...identity, attempts: 0 };
    if (fs.existsSync(file)) {
      try {
        if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 4096) throw new Error();
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RecoveryState;
        if (parsed.version !== 1 || parsed.snapshotId !== identity.snapshotId || parsed.stage !== identity.stage ||
            parsed.page !== identity.page || !Number.isInteger(parsed.attempts) || parsed.attempts < 0 || parsed.attempts > 3 ||
            (parsed.lastErrorCode !== undefined && !RECOVERABLE.has(parsed.lastErrorCode))) throw new Error();
        state = parsed;
      } catch { throw new PortableStageRecoveryError("stage_recovery_state_invalid", 0); }
    }
    const save = () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    };
    for (;;) {
      options.signal?.throwIfAborted();
      if (state.attempts > 0 && options.recoverCheckpoint) {
        const recovered = await options.recoverCheckpoint();
        options.signal?.throwIfAborted();
        if (recovered !== undefined) return recovered;
      }
      if (state.attempts >= retries + 1) {
        throw new PortableStageRecoveryError("stage_recovery_exhausted", state.attempts, state.lastErrorCode);
      }
      state.attempts++;
      save(); // Count before dispatch, including attempts interrupted during execution.
      if (state.lastErrorCode) options.onRecovery?.({ stage: options.stage, page: options.page,
        attempt: state.attempts, priorErrorCode: state.lastErrorCode });
      try { return await options.run(state.attempts, state.lastErrorCode); }
      catch (error) {
        options.signal?.throwIfAborted();
        const code = errorCode(error);
        if (!code) throw error; // Authentication, cost, cancellation, protocol and unknown errors are terminal.
        state.lastErrorCode = code;
        save();
      }
    }
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}
