import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The ceiling on the fallback path, when the delivery does not say which App it
 * came from. The timing leak of trying every configured secret is the *number* of
 * App connections, which an administrator already knows.
 */
export const MAX_WEBHOOK_SECRETS_TRIED = 20;

const PREFIX = "sha256=";
const HEX_DIGEST = /^[0-9a-f]{64}$/i;
const DIGEST_BYTES = 32;

export interface GitHubWebhookSecret {
  connectionId: string;
  secret: string;
  /**
   * The App id of the connection, which GitHub echoes in
   * `X-GitHub-Hook-Installation-Target-ID`. `null` or absent means we do not know
   * it, and the secret stays a candidate for every delivery.
   */
  appId?: string | null;
}

export interface VerifyGitHubSignatureInput {
  /** The bytes exactly as they arrived: a re-serialized payload has another digest. */
  body: Uint8Array;
  header: string | undefined;
  secrets: ReadonlyArray<GitHubWebhookSecret>;
  /** `X-GitHub-Hook-Installation-Target-ID`, the App the delivery claims to be from. */
  appId?: string | undefined;
}

/**
 * Whether the header could possibly be a signature, decided by shape alone. The
 * endpoint is unauthenticated, so this runs *before* the body is read: a malformed
 * header must never cost a 1 MiB read, let alone a hash.
 */
export function isWellFormedSignatureHeader(header: string | undefined): boolean {
  const value = header?.trim() ?? "";
  return value.startsWith(PREFIX) && HEX_DIGEST.test(value.slice(PREFIX.length));
}

export interface WebhookSecretSelection {
  /** The secrets worth hashing against, in a stable order, capped. */
  candidates: ReadonlyArray<GitHubWebhookSecret>;
  /** A connection claims the App id the delivery named: normally one hash. */
  matchedAppId: boolean;
  /**
   * The delivery named an App id and **no** connection claims it. The candidates
   * are then the whole capped loop rather than nothing: a recorded App id can be
   * wrong (the installation id, the client id, the slug), and refusing in silence
   * would answer `401` for every delivery of that connection — the same code as a
   * wrong secret. The caller logs `webhook_app_id_unmatched`.
   */
  unmatchedAppId: boolean;
}

/**
 * Which secrets one delivery is worth hashing against, and what that says about
 * the App id it carried. With the App id recognised this is normally exactly one
 * secret, so an unauthenticated caller costs a single HMAC rather than twenty.
 */
export function webhookSecretSelection(
  secrets: ReadonlyArray<GitHubWebhookSecret>,
  appId: string | undefined,
): WebhookSecretSelection {
  const usable = secrets.filter((entry) => entry.secret !== "");
  const capped = (entries: ReadonlyArray<GitHubWebhookSecret>) => entries.slice(0, MAX_WEBHOOK_SECRETS_TRIED);
  if (appId === undefined || appId === "") {
    return { candidates: capped(usable), matchedAppId: false, unmatchedAppId: false };
  }
  const named = usable.filter((entry) => entry.appId === appId);
  if (named.length > 0) {
    // A connection whose App id we have not recorded stays a candidate too, so a
    // store that predates the column keeps working instead of refusing everything.
    const unrecorded = usable.filter((entry) => entry.appId === null || entry.appId === undefined);
    return { candidates: capped([...named, ...unrecorded]), matchedAppId: true, unmatchedAppId: false };
  }
  return { candidates: capped(usable), matchedAppId: false, unmatchedAppId: true };
}

export function candidateWebhookSecrets(
  secrets: ReadonlyArray<GitHubWebhookSecret>,
  appId: string | undefined,
): ReadonlyArray<GitHubWebhookSecret> {
  return webhookSecretSelection(secrets, appId).candidates;
}

/**
 * Whether the delivery names an App id a connection actually claims. The webhook's
 * admission control reads this **before** the body: a flood that cannot even name
 * one of our Apps is shed for the price of a header lookup.
 */
export function namesKnownWebhookApp(
  secrets: ReadonlyArray<GitHubWebhookSecret>,
  appId: string | undefined,
): boolean {
  return webhookSecretSelection(secrets, appId).matchedAppId;
}

/**
 * HMAC-SHA256 over the raw body, compared in constant time against the candidate
 * App secrets in the order given. The first match names the connection the
 * delivery belongs to; `null` means no connection claims it, and the caller must
 * then answer `401 signature_invalid` and record nothing.
 */
export function verifyGitHubSignature(
  input: VerifyGitHubSignatureInput,
): { connectionId: string } | null {
  const header = input.header?.trim() ?? "";
  if (!header.startsWith(PREFIX)) return null;
  const digest = header.slice(PREFIX.length);
  if (!HEX_DIGEST.test(digest)) return null;
  const provided = Buffer.from(digest, "hex");
  if (provided.length !== DIGEST_BYTES) return null;
  for (const { connectionId, secret } of candidateWebhookSecrets(input.secrets, input.appId)) {
    // An empty key is a legal HMAC key, so a connection whose secret was never
    // configured would authenticate anyone who signed with "". `candidateWebhookSecrets`
    // drops those; this is the second line of the same defence.
    if (secret === "") continue;
    const expected = createHmac("sha256", secret).update(input.body).digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { connectionId };
  }
  return null;
}
