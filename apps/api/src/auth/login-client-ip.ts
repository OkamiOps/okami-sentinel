import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * A per-IP limiter is only worth anything if the caller cannot choose its own
 * bucket. `X-Forwarded-For` is caller-supplied unless exactly one trusted proxy
 * terminates the connection, and even then only the entry that proxy appended —
 * the RIGHTMOST one — is its own observation.
 *
 * `null` means no bucket can be attributed, and the caller must then not limit
 * rather than lump every unattributable request together.
 */
export function loginBucket(forwardedFor: string | undefined, peer: string | null, trustProxy: boolean): string | null {
  if (!trustProxy) return peer?.trim().slice(0, 64) || null;
  const appended = (forwardedFor ?? "").split(",").at(-1)?.trim() ?? "";
  return appended.slice(0, 64) || null;
}

/** `getConnInfo` needs the Node listener; `app.request` has no socket at all. */
export function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function clientIp(c: Context, trustProxy: boolean): string | null {
  return loginBucket(c.req.header("X-Forwarded-For"), peerAddress(c), trustProxy);
}
