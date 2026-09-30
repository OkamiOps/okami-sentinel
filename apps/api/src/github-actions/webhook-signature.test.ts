import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { MAX_WEBHOOK_SECRETS_TRIED, verifyGitHubSignature } from "./webhook-signature.js";

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
