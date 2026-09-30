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

/**
 * The secrets worth hashing against for one delivery. With the App id present
 * that is normally exactly one, so an unauthenticated caller can cost us a single
 * HMAC rather than twenty. An App id that no connection claims yields **nothing**:
 * hashing would be pure waste, and refusing is the same answer we would reach.
 */
export function candidateWebhookSecrets(
  secrets: ReadonlyArray<GitHubWebhookSecret>,
  appId: string | undefined,
): ReadonlyArray<GitHubWebhookSecret> {
  const usable = secrets.filter((entry) => entry.secret !== "");
  if (appId === undefined || appId === "") return usable.slice(0, MAX_WEBHOOK_SECRETS_TRIED);
  // A connection whose App id we have not recorded stays a candidate, so a store
  // that predates the column keeps working instead of refusing everything.
  const named = usable.filter((entry) => entry.appId === appId || entry.appId === null || entry.appId === undefined);
  return named.slice(0, MAX_WEBHOOK_SECRETS_TRIED);
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
