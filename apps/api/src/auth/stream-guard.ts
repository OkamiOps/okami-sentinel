import type { Context } from "hono";
import { principalForSession } from "./auth-service.js";
import { canSeeRepository, principalOf } from "./principal.js";
import { getSessionById } from "./session-store.js";

/**
 * A server-sent-events stream outlives the single authorization decision the
 * route policy made when it opened, so a revoked session, a disabled account or
 * a withdrawn grant would keep receiving scan and gate events indefinitely. The
 * guard re-reads the session and the grants at most once per `intervalMs` and
 * answers `false` as soon as the principal can no longer see the repository the
 * stream belongs to; the caller closes the loop on that answer.
 *
 * The local runtime has no sessions and a single implicit administrator, so its
 * streams are never re-authorized and never pay for the extra queries.
 */
export function createStreamGuard(
  c: Context,
  repositoryKey: () => string | null | undefined,
  intervalMs = 60_000,
  now: () => number = Date.now,
): () => boolean {
  const initial = principalOf(c);
  if (initial.kind === "local") return () => true;
  let checkedAt = now();
  let allowed = true;
  return () => {
    if (!allowed) return false;
    if (now() - checkedAt < intervalMs) return true;
    checkedAt = now();
    const session = initial.sessionId ? getSessionById(initial.sessionId) : null;
    const principal = session ? principalForSession(session) : null;
    allowed = principal !== null && canSeeRepository(principal, repositoryKey());
    return allowed;
  };
}
