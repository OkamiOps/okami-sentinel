import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The timing leak of trying every configured secret is the *number* of App
 * connections, which an administrator already knows. The cap keeps that leak and
 * the per-request work bounded no matter how many connections exist.
 */
export const MAX_WEBHOOK_SECRETS_TRIED = 20;

const PREFIX = "sha256=";
const HEX_DIGEST = /^[0-9a-f]{64}$/i;
const DIGEST_BYTES = 32;

export interface GitHubWebhookSecret {
  connectionId: string;
  secret: string;
}

export interface VerifyGitHubSignatureInput {
  /** The bytes exactly as they arrived: a re-serialized payload has another digest. */
  body: Uint8Array;
  header: string | undefined;
  secrets: ReadonlyArray<GitHubWebhookSecret>;
}

/**
 * HMAC-SHA256 over the raw body, compared in constant time against every
 * configured App secret in the order given. The first match names the connection
 * the delivery belongs to; `null` means no connection claims it, and the caller
 * must then answer `401 signature_invalid` and record nothing.
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
  for (const { connectionId, secret } of input.secrets.slice(0, MAX_WEBHOOK_SECRETS_TRIED)) {
    // An empty key is a legal HMAC key, so a connection whose secret was never
    // configured would authenticate anyone who signed with "".
    if (secret === "") continue;
    const expected = createHmac("sha256", secret).update(input.body).digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { connectionId };
  }
  return null;
}
