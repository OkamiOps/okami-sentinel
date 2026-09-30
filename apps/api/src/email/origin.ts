import { publicOrigin, runtimeMode } from "../deployment-settings.js";

/**
 * The origin every link in an e-mail is built from, or `null` when there is
 * none. Local mode has no public address, so its messages carry no links at all
 * — a relative href is dead in a mail client, and inventing `localhost` would
 * point the reader at their own machine.
 *
 * Deliberately forgiving: a malformed `CSB_PUBLIC_ORIGIN` already stops the
 * server from starting, and a notification is not the place to turn that into a
 * second failure. A message without a link still tells the recipient what
 * happened.
 */
export function emailPublicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return runtimeMode(env) === "server" ? publicOrigin(env) : null;
  } catch {
    return null;
  }
}
