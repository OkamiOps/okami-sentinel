import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { createSmtpTransport, mapSmtpError, smtpTransportOptions } from "./smtp-transport.js";
import { EmailTransportError, type EmailTransportConfig } from "./transport.js";

interface Received {
  from: string;
  to: string[];
  raw: string;
}

/** A real socket on a loopback port: the handshake and AUTH are not simulated. */
async function startServer(
  options: Partial<SMTPServerOptions>,
  received: Received[] = [],
): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const server = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    authOptional: true,
    hideSTARTTLS: true,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom === false ? "" : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((entry) => entry.address),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        callback();
      });
    },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server.server, "listening");
  const address = server.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function config(port: number, overrides: Partial<EmailTransportConfig> = {}): EmailTransportConfig {
  return {
    provider: "smtp",
    fromName: "Okami Sentinel",
    fromAddress: "sentinel@okami.example",
    replyTo: null,
    smtp: { host: "127.0.0.1", port, security: "none", username: null },
    secret: null,
    timeoutMs: 5_000,
    ...overrides,
  };
}

const message = {
  to: "ana@example.com",
  subject: "Sentinel test",
  html: "<p>ok</p>",
  text: "ok",
  idempotencyKey: "out_abc-123",
};

test("delivers over a real SMTP socket with the sender, recipient and both bodies", async (t) => {
  const server = await startServer({});
  t.after(server.close);

  const result = await createSmtpTransport(config(server.port)).send(message);

  assert.equal(server.received.length, 1);
  const mail = server.received[0]!;
  assert.equal(mail.from, "sentinel@okami.example");
  assert.deepEqual(mail.to, ["ana@example.com"]);
  // nodemailer drops the quotes a plain display name does not need.
  assert.match(mail.raw, /^From: "?Okami Sentinel"? <sentinel@okami\.example>$/m);
  assert.match(mail.raw, /^Subject: Sentinel test$/m);
  assert.ok(mail.raw.includes("<p>ok</p>"));
  // The outbox id becomes the Message-ID, so a retried row keeps one identity.
  assert.match(mail.raw, /^Message-ID: <out_abc-123@okami\.example>$/m);
  assert.equal(result.providerMessageId, "<out_abc-123@okami.example>");
});

test("authenticates when a username is configured and reports a rejected login", async (t) => {
  const seen: Array<{ user: string; pass: string }> = [];
  const server = await startServer({
    authOptional: false,
    authMethods: ["PLAIN", "LOGIN"],
    onAuth(auth, _session, callback) {
      seen.push({ user: auth.username ?? "", pass: auth.password ?? "" });
      if (auth.password === "right-password") return callback(null, { user: auth.username });
      return callback(new Error("Invalid login"));
    },
  });
  t.after(server.close);

  await createSmtpTransport(
    config(server.port, { smtp: { host: "127.0.0.1", port: server.port, security: "none", username: "resend" }, secret: "right-password" }),
  ).send(message);
  assert.deepEqual(seen, [{ user: "resend", pass: "right-password" }]);
  assert.equal(server.received.length, 1);

  await assert.rejects(
    createSmtpTransport(
      config(server.port, { smtp: { host: "127.0.0.1", port: server.port, security: "none", username: "resend" }, secret: "wrong-password" }),
    ).send(message),
    (error: EmailTransportError) => {
      assert.equal(error.code, "auth_rejected");
      assert.equal(error.permanent, true);
      return true;
    },
  );
  assert.equal(server.received.length, 1);
});

test("a sender the relay refuses is reported as an unverified sender", async (t) => {
  const server = await startServer({
    onMailFrom(_address, _session, callback) {
      callback(Object.assign(new Error("Sender address not verified"), { responseCode: 550 }));
    },
  });
  t.after(server.close);

  await assert.rejects(createSmtpTransport(config(server.port)).send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "sender_not_verified");
    assert.equal(error.permanent, true);
    assert.ok(error.message.includes("not verified"), error.message);
    return true;
  });
});

test("a rejected recipient is permanent and a temporary refusal is not", async (t) => {
  let attempt = 0;
  const server = await startServer({
    onRcptTo(_address, _session, callback) {
      attempt += 1;
      callback(Object.assign(
        new Error(attempt === 1 ? "No such user here" : "Try again later"),
        { responseCode: attempt === 1 ? 550 : 451 },
      ));
    },
  });
  t.after(server.close);

  await assert.rejects(createSmtpTransport(config(server.port)).send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "recipient_rejected");
    assert.equal(error.permanent, true);
    return true;
  });
  await assert.rejects(createSmtpTransport(config(server.port)).send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "recipient_rejected");
    return true;
  });
});

test("a closed port is a refused connection", async () => {
  const idle = await startServer({});
  const port = idle.port;
  await idle.close();

  await assert.rejects(createSmtpTransport(config(port)).send(message), (error: EmailTransportError) => {
    assert.equal(error.code, "connection_refused");
    assert.equal(error.permanent, false);
    return true;
  });
});

test("a relay that accepts the socket and never greets times out", async (t) => {
  // A bare TCP listener, not an SMTP server: it accepts the connection and says
  // nothing, which is exactly the shape the greeting timeout has to survive.
  const sockets = new Set<Socket>();
  const mute = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  mute.listen(0, "127.0.0.1");
  await once(mute, "listening");
  const address = mute.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => mute.close(() => resolve()));
  });

  await assert.rejects(
    createSmtpTransport(config(address.port, { timeoutMs: 200 })).send(message),
    (error: EmailTransportError) => {
      assert.equal(error.code, "connection_timeout");
      assert.equal(error.permanent, false);
      return true;
    },
  );
});

test("requiring STARTTLS on a relay that cannot offer it fails as a TLS problem", async (t) => {
  const server = await startServer({});
  t.after(server.close);

  await assert.rejects(
    createSmtpTransport(
      config(server.port, { smtp: { host: "127.0.0.1", port: server.port, security: "starttls", username: null } }),
    ).send(message),
    (error: EmailTransportError) => {
      assert.equal(error.code, "tls_failed");
      assert.equal(error.permanent, true);
      return true;
    },
  );
  assert.equal(server.received.length, 0);
});

test("each security mode maps to one explicit nodemailer setting", () => {
  const base = { host: "smtp.example", port: 465, username: null as string | null };
  assert.deepEqual(
    pick(smtpTransportOptions(config(1, { smtp: { ...base, security: "tls" } }))),
    { secure: true, requireTLS: false, ignoreTLS: false, auth: undefined },
  );
  assert.deepEqual(
    pick(smtpTransportOptions(config(1, { smtp: { ...base, port: 587, security: "starttls" } }))),
    { secure: false, requireTLS: true, ignoreTLS: false, auth: undefined },
  );
  assert.deepEqual(
    pick(smtpTransportOptions(config(1, { smtp: { ...base, port: 25, security: "none" } }))),
    { secure: false, requireTLS: false, ignoreTLS: true, auth: undefined },
  );
  assert.deepEqual(
    smtpTransportOptions(config(1, { smtp: { ...base, security: "tls", username: "resend" }, secret: "k" })).auth,
    { user: "resend", pass: "k" },
  );
  // A timeout is always set, so a hung relay cannot hold the worker for ever.
  const options = smtpTransportOptions(config(1, { smtp: { ...base, security: "tls" } }));
  assert.equal(options.connectionTimeout, 5_000);
  assert.equal(options.greetingTimeout, 5_000);
  assert.equal(options.socketTimeout, 5_000);
  assert.equal(smtpTransportOptions({ ...config(1), timeoutMs: undefined }).socketTimeout, 20_000);
  assert.throws(() => smtpTransportOptions(config(1, { smtp: null })), /not configured/);
});

function pick(options: { secure?: boolean; requireTLS?: boolean; ignoreTLS?: boolean; auth?: unknown }) {
  return {
    secure: options.secure, requireTLS: options.requireTLS,
    ignoreTLS: options.ignoreTLS, auth: options.auth,
  };
}

test("the error map covers the codes nodemailer actually raises", () => {
  const expectations: Array<[Record<string, unknown>, string, boolean]> = [
    [{ code: "EAUTH", response: "535 auth failed" }, "auth_rejected", true],
    [{ code: "ENOAUTH" }, "auth_rejected", true],
    [{ code: "ETLS", message: "STARTTLS failed" }, "tls_failed", true],
    [{ code: "ESOCKET", message: "wrong version number" }, "tls_failed", true],
    [{ code: "ECONNECTION", message: "connect ECONNREFUSED 127.0.0.1:2525" }, "connection_refused", false],
    [{ code: "EDNS", message: "getaddrinfo ENOTFOUND smtp.nope" }, "connection_refused", false],
    [{ code: "ETIMEDOUT", message: "Greeting never received" }, "connection_timeout", false],
    [{ code: "EENVELOPE", command: "MAIL FROM", response: "550 sender rejected" }, "sender_not_verified", true],
    [{ code: "EENVELOPE", command: "RCPT TO", response: "550 no such user" }, "recipient_rejected", true],
    [{ code: "EMESSAGE", response: "554 message content rejected" }, "message_rejected", true],
    [{ code: "EPROTOCOL", responseCode: 421, response: "421 service closing" }, "provider_unavailable", false],
    [{}, "provider_unavailable", false],
  ];
  for (const [shape, code, permanent] of expectations) {
    const failure = mapSmtpError(Object.assign(new Error(String(shape.message ?? "failed")), shape));
    assert.equal(failure.code, code, JSON.stringify(shape));
    assert.equal(failure.permanent, permanent, code);
    assert.ok(!failure.message.includes("\n"), failure.message);
  }
});
