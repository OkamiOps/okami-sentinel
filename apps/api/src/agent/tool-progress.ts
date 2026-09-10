import { createHash } from "node:crypto";

export const TOOL_PROGRESS_GUIDANCE = "Sentinel guidance: recent inspection calls repeat already-seen results or fail without new evidence. Reuse the source and graph results already returned. Correct invalid arguments using the tool schema, or inspect a different relevant caller, callee, control or source range. Continue investigating unresolved evidence; do not invent findings or mark unexamined code as reviewed. Write the result only when the assigned review is complete.";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** Advisory only: a finite digest cache, never a tool/session termination counter. */
export class ToolProgressTracker {
  private readonly seen = new Set<string>();
  private stalled = 0;

  observe(name: string, input: unknown, content: string, failed: boolean): boolean {
    if (!name.startsWith("workspace.")) return false;
    const digest = createHash("sha256").update(JSON.stringify([name, canonical(input), content])).digest("hex");
    const repeated = this.seen.has(digest);
    if (!failed && !repeated) {
      this.seen.add(digest);
      if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
      this.stalled = 0;
      return false;
    }
    this.stalled += 1;
    if (this.stalled < 3) return false;
    this.stalled = 0;
    return true;
  }
}
