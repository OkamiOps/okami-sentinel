import assert from "node:assert/strict";
import test from "node:test";
import { createResendTransport, mapResendResponse, RESEND_ENDPOINT } from "./resend-transport.js";
import { EmailTransportError, type EmailTransportConfig } from "./transport.js";

const config: EmailTransportConfig = {
  provider: "resend",
  fromName: "Okami Sentinel",
  fromAddress: "sentinel@okami.example",
  replyTo: "ops@okami.example",
  smtp: null,
  secret: "re_live_secret_key",
};

interface Captured {
  url: string;
  init: RequestInit;
}

function stub(status: number, body: unknown, captured: Captured[] = []) {
  return {
    captured,
    fetch: async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return new Response(body === null ? "" : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

const message = {
  to: "ana@example.com",
  subject: "Sentinel test",
  html: "<p>ok</p>",
  text: "ok",
  idempotencyKey: "out_abc123",
};

test("a send posts the rendered message with the bearer key and the idempotency key", async () => {
  const { fetch, captured } = stub(200, { id: "3f5c-resend-id" });
  const result = await createResendTransport(config, fetch).send(message);

  assert.deepEqual(result, { providerMessageId: "3f5c-resend-id" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, RESEND_ENDPOINT);
  assert.equal(captured[0]!.init.method, "POST");
  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_live_secret_key");
  assert.equal(headers["Idempotency-Key"], "out_abc123");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(captured[0]!.init.body)), {
    from: '"Okami Sentinel" <sentinel@okami.example>',
    to: ["ana@example.com"],
    subject: "Sentinel test",
    html: "<p>ok</p>",
    text: "ok",
    reply_to: "ops@okami.example",
  });
});

test("a response without an id is still a success", async () => {
  const { fetch } = stub(200, {});
  assert.deepEqual(await createResendTransport(config, fetch).send(message), { providerMessageId: null });
});

test("a missing API key never reaches the network", async () => {
  let called = false;
  const transport = createResendTransport({ ...config, secret: "  " }, async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(transport.send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "not_configured");
    assert.equal(error.permanent, true);
    return true;
  });
  assert.equal(called, false);
});

test("provider status codes become actionable, classified failures", async () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [401, { message: "API key is invalid" }, "auth_rejected", true],
    [403, { message: "Forbidden" }, "auth_rejected", true],
    [429, { message: "Too many requests" }, "rate_limited", false],
    [500, { message: "Internal" }, "provider_unavailable", false],
    [503, null, "provider_unavailable", false],
    [422, { message: "The okami.example domain is not verified. Please verify a domain." }, "sender_not_verified", true],
    [422, { message: "Invalid `to` field: recipient is not a valid email" }, "recipient_rejected", true],
    [400, { message: "Something entirely new" }, "message_rejected", true],
  ];
  for (const [status, body, code, permanent] of cases) {
    const { fetch } = stub(status, body);
    await assert.rejects(
      createResendTransport(config, fetch).send(message),
      (error: EmailTransportError) => {
        assert.equal(error.code, code, `${status} ${JSON.stringify(body)}`);
        assert.equal(error.permanent, permanent, code);
        assert.ok(error.message.length > 0);
        return true;
      },
    );
  }
});

test("the provider's own words are folded into one redacted line", () => {
  const failure = mapResendResponse(422, { message: "Line one\r\nLine two\ttabbed   " });
  assert.equal(failure.code, "message_rejected");
  assert.ok(!failure.message.includes("\n"), failure.message);
  assert.ok(failure.message.includes("Line one Line two tabbed"), failure.message);
  assert.equal(mapResendResponse(500, "  ").message.includes("("), false);
});

test("a refused connection and a timeout are transient, not permanent", async () => {
  const refused = createResendTransport(config, async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  await assert.rejects(refused.send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "connection_refused");
    assert.equal(error.permanent, false);
    return true;
  });

  const hung = createResendTransport({ ...config, timeoutMs: 20 }, (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
  await assert.rejects(hung.send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "connection_timeout");
    assert.equal(error.permanent, false);
    return true;
  });
});

test("the timeout also covers a response whose body never finishes", async () => {
  // Resend has answered with headers, so the request is past the point the
  // connection timeout watches. A body that then hangs must not hold the outbox
  // worker for ever, and must not be mistaken for an empty success either.
  const hung = createResendTransport({ ...config, timeoutMs: 120 }, async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const started = Date.now();
  await assert.rejects(hung.send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "connection_timeout");
    assert.equal(error.permanent, false);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, `waited ${Date.now() - started}ms`);
});

test("a body that is not JSON is still read, and does not become a failure", async () => {
  const transport = createResendTransport(config, async () => new Response("not json at all", { status: 200 }));
  assert.deepEqual(await transport.send(message), { providerMessageId: null });
});

test("a sender without a display name is sent as a bare address", async () => {
  const { fetch, captured } = stub(200, { id: "x" });
  await createResendTransport({ ...config, fromName: "  ", replyTo: null }, fetch).send(message);
  const body = JSON.parse(String(captured[0]!.init.body));
  assert.equal(body.from, "sentinel@okami.example");
  assert.equal("reply_to" in body, false);
});

test("a display name cannot smuggle a quote or a header break into From", async () => {
  const { fetch, captured } = stub(200, { id: "x" });
  await createResendTransport(
    { ...config, fromName: 'Okami" <evil@example.com>\r\nBcc: eve@example.com' },
    fetch,
  ).send(message);
  const from = String(JSON.parse(String(captured[0]!.init.body)).from);
  assert.equal(from, '"Okami <evil@example.com>Bcc: eve@example.com" <sentinel@okami.example>');
  assert.ok(!from.includes("\r") && !from.includes("\n"));
});
