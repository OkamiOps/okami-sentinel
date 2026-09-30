import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  MAX_WEBHOOK_SECRETS_TRIED,
  candidateWebhookSecrets,
  isWellFormedSignatureHeader,
  verifyGitHubSignature,
} from "./webhook-signature.js";

const sign = (secret: string, body: Uint8Array): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const secrets = (...pairs: Array<[string, string]>): Array<{ connectionId: string; secret: string }> =>
  pairs.map(([connectionId, secret]) => ({ connectionId, secret }));

test("accepts a payload with multi-byte characters over the bytes as received", () => {
  const body = new TextEncoder().encode(JSON.stringify({ title: "Corrige acentuação — ação" }));
  assert.deepEqual(
    verifyGitHubSignature({ body, header: sign("s1", body), secrets: secrets(["c1", "s1"]) }),
    { connectionId: "c1" },
  );

  // A body whose bytes cannot survive a parse/serialize round trip: the digest
  // must be taken over what arrived, never over a re-serialization of it.
  const raw = new TextEncoder().encode('{"a":1,  "b":"\\u00e9"}');
  const header = sign("s1", raw);
  assert.deepEqual(
    verifyGitHubSignature({ body: raw, header, secrets: secrets(["c1", "s1"]) }),
    { connectionId: "c1" },
  );
  const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw))));
  assert.notEqual(Buffer.compare(Buffer.from(raw), Buffer.from(reserialized)), 0);
  assert.equal(verifyGitHubSignature({ body: reserialized, header, secrets: secrets(["c1", "s1"]) }), null);
});

test("picks the connection whose secret matches", () => {
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const all = secrets(["c1", "wrong-one"], ["c2", "wrong-two"], ["c3", "right"]);
  assert.deepEqual(verifyGitHubSignature({ body, header: sign("right", body), secrets: all }), { connectionId: "c3" });
  // The first match names the connection, even when a later one also matches.
  const twins = secrets(["c1", "shared"], ["c2", "shared"]);
  assert.deepEqual(verifyGitHubSignature({ body, header: sign("shared", body), secrets: twins }), { connectionId: "c1" });
});

test("returns null with no secrets configured", () => {
  assert.equal(verifyGitHubSignature({ body: new Uint8Array([1]), header: "sha256=ab", secrets: [] }), null);
  const body = new Uint8Array([1]);
  assert.equal(verifyGitHubSignature({ body, header: sign("s1", body), secrets: [] }), null);
});

test("rejects a missing header, a header without the sha256 prefix, a non-hex digest and a truncated digest", () => {
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const valid = sign("s1", body).slice("sha256=".length);
  const configured = secrets(["c1", "s1"]);
  for (const header of [
    undefined,
    "",
    "   ",
    valid,
    `sha1=${valid}`,
    `sha256=${"z".repeat(64)}`,
    `sha256=${valid.slice(0, 62)}`,
    `sha256=${valid}00`,
    "sha256=",
  ]) {
    assert.equal(verifyGitHubSignature({ body, header, secrets: configured }), null, `header ${String(header)}`);
  }
  // Same digest, one byte of body changed.
  const tampered = new TextEncoder().encode('{"zen":"ok!"}');
  assert.equal(verifyGitHubSignature({ body: tampered, header: sign("s1", body), secrets: configured }), null);
  // A surrounding-whitespace header is still the same signature.
  assert.deepEqual(
    verifyGitHubSignature({ body, header: ` ${sign("s1", body)} `, secrets: configured }),
    { connectionId: "c1" },
  );
});

test("tries at most twenty secrets", () => {
  assert.equal(MAX_WEBHOOK_SECRETS_TRIED, 20);
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const many = Array.from({ length: 25 }, (_, index) => ({ connectionId: `c${index}`, secret: `s${index}` }));
  assert.deepEqual(verifyGitHubSignature({ body, header: sign("s19", body), secrets: many }), { connectionId: "c19" });
  assert.equal(verifyGitHubSignature({ body, header: sign("s20", body), secrets: many }), null);
  assert.equal(verifyGitHubSignature({ body, header: sign("s24", body), secrets: many }), null);
});

test("an empty or unusable secret never matches", () => {
  const body = new TextEncoder().encode('{"zen":"ok"}');
  // An empty secret is a valid HMAC key, so it would otherwise authenticate a
  // caller against a connection whose secret was never configured.
  assert.equal(verifyGitHubSignature({ body, header: sign("", body), secrets: secrets(["c1", ""]) }), null);
  assert.deepEqual(
    verifyGitHubSignature({ body, header: sign("s1", body), secrets: secrets(["c1", ""], ["c2", "s1"]) }),
    { connectionId: "c2" },
  );
});

/**
 * N-1. Verification is what an unauthenticated caller can make us pay for, so it
 * has to be one HMAC in the normal case. App webhooks carry the App id in
 * `X-GitHub-Hook-Installation-Target-ID`, which names the connection before a
 * single hash is computed.
 */
test("hashes once when the delivery names the App it came from", () => {
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const configured = [
    { connectionId: "c1", secret: "s1", appId: "1001" },
    { connectionId: "c2", secret: "s2", appId: "1002" },
    { connectionId: "c3", secret: "s3", appId: "1003" },
  ];
  assert.deepEqual(
    verifyGitHubSignature({ body, header: sign("s2", body), secrets: configured, appId: "1002" }),
    { connectionId: "c2" },
  );
  assert.deepEqual(candidateWebhookSecrets(configured, "1002").map((one) => one.connectionId), ["c2"]);
  // The named App's secret is the only one tried: another connection's valid
  // signature is not accepted under the wrong App id.
  assert.equal(
    verifyGitHubSignature({ body, header: sign("s3", body), secrets: configured, appId: "1002" }),
    null,
  );
});

test("refuses a delivery naming an App id no connection owns, without hashing", () => {
  const body = new TextEncoder().encode('{"zen":"ok"}');
  const configured = [
    { connectionId: "c1", secret: "s1", appId: "1001" },
    { connectionId: "c2", secret: "s2", appId: "1002" },
  ];
  assert.deepEqual(candidateWebhookSecrets(configured, "9999"), []);
  assert.equal(
    verifyGitHubSignature({ body, header: sign("s1", body), secrets: configured, appId: "9999" }),
    null,
  );
});

test("falls back to the capped loop when the App id is absent or unknown to us", () => {
  const body = new TextEncoder().encode('{"zen":"ok"}');
  // No header: every configured secret is a candidate, still capped at twenty.
  const configured = [
    { connectionId: "c1", secret: "s1", appId: "1001" },
    { connectionId: "c2", secret: "s2", appId: "1002" },
  ];
  assert.equal(candidateWebhookSecrets(configured, undefined).length, 2);
  assert.deepEqual(
    verifyGitHubSignature({ body, header: sign("s2", body), secrets: configured, appId: undefined }),
    { connectionId: "c2" },
  );
  // A connection whose App id we do not know yet is always a candidate, so a
  // half-migrated store keeps working.
  const partial = [
    { connectionId: "c1", secret: "s1", appId: null },
    { connectionId: "c2", secret: "s2", appId: "1002" },
  ];
  assert.deepEqual(candidateWebhookSecrets(partial, "1001").map((one) => one.connectionId), ["c1"]);
  assert.deepEqual(
    verifyGitHubSignature({ body, header: sign("s1", body), secrets: partial, appId: "1001" }),
    { connectionId: "c1" },
  );
  const many = Array.from({ length: 25 }, (_, index) => ({ connectionId: `c${index}`, secret: `s${index}` }));
  assert.equal(candidateWebhookSecrets(many, undefined).length, MAX_WEBHOOK_SECRETS_TRIED);
});

test("recognises a well-formed signature header before any body is read", () => {
  const valid = `sha256=${"a".repeat(64)}`;
  assert.ok(isWellFormedSignatureHeader(valid));
  assert.ok(isWellFormedSignatureHeader(` ${valid} `));
  for (const header of [undefined, "", "   ", "a".repeat(64), `sha1=${"a".repeat(64)}`,
    `sha256=${"z".repeat(64)}`, `sha256=${"a".repeat(63)}`, `sha256=${"a".repeat(65)}`, "sha256="]) {
    assert.ok(!isWellFormedSignatureHeader(header), `header ${String(header)}`);
  }
});
