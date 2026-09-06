import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetch, type Dispatcher } from "undici";

import {
  createPinnedCustomEndpointDispatcher,
  PinnedCustomEndpointError,
  type PinnedCustomEndpointDispatcherInput,
} from "./pinned-custom-endpoint.js";

function fixture(addresses: Array<{ address: string; family: 4 | 6 }>) {
  const lookups: string[] = [];
  const dispatchers: PinnedCustomEndpointDispatcherInput[] = [];
  return {
    lookups,
    dispatchers,
    dependencies: {
      async resolve(hostname: string) {
        lookups.push(hostname);
        return addresses;
      },
      createDispatcher(input: PinnedCustomEndpointDispatcherInput) {
        dispatchers.push(input);
        return { close: async () => undefined } as Dispatcher;
      },
    },
  };
}

test("pins a public custom hostname to the vetted address while retaining its hostname", async () => {
  const state = fixture([{ address: "8.8.8.8", family: 4 }]);

  await createPinnedCustomEndpointDispatcher(
    "https://gateway.example/v1/chat/completions",
    false,
    state.dependencies,
  );

  assert.deepEqual(state.lookups, ["gateway.example"]);
  assert.deepEqual(state.dispatchers, [{
    hostname: "gateway.example",
    address: { address: "8.8.8.8", family: 4 },
  }]);
});

test("rejects rebinding answers that contain any private or link-local address", async () => {
  const mixed = fixture([
    { address: "8.8.8.8", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);
  const ipv6 = fixture([{ address: "fe80::1", family: 6 }]);

  await assert.rejects(
    createPinnedCustomEndpointDispatcher("https://gateway.example/v1", false, mixed.dependencies),
    PinnedCustomEndpointError,
  );
  await assert.rejects(
    createPinnedCustomEndpointDispatcher("https://gateway.example/v1", false, ipv6.dependencies),
    PinnedCustomEndpointError,
  );
  assert.deepEqual(mixed.dispatchers, []);
  assert.deepEqual(ipv6.dispatchers, []);
});

test("permits loopback only through the explicit local override", async () => {
  const blocked = fixture([{ address: "127.0.0.1", family: 4 }]);
  const allowed = fixture([{ address: "127.0.0.1", family: 4 }]);
  const spoofedLocalhost = fixture([{ address: "8.8.8.8", family: 4 }]);
  const publicHostnameToLoopback = fixture([{ address: "127.0.0.1", family: 4 }]);

  await assert.rejects(
    createPinnedCustomEndpointDispatcher("http://localhost:7331/v1", false, blocked.dependencies),
    PinnedCustomEndpointError,
  );
  await createPinnedCustomEndpointDispatcher(
    "http://localhost:7331/v1",
    true,
    allowed.dependencies,
  );
  await assert.rejects(
    createPinnedCustomEndpointDispatcher("https://service.localhost/v1", true, spoofedLocalhost.dependencies),
    PinnedCustomEndpointError,
  );
  await assert.rejects(
    createPinnedCustomEndpointDispatcher("https://gateway.example/v1", true, publicHostnameToLoopback.dependencies),
    PinnedCustomEndpointError,
  );
  assert.equal(allowed.dispatchers[0]?.hostname, "localhost");
});

test("accepts a public IPv6 answer and does not resolve an IP literal again", async () => {
  const ipv6 = fixture([{ address: "2606:4700:4700::1111", family: 6 }]);
  const literal = fixture([]);

  await createPinnedCustomEndpointDispatcher("https://gateway.example/v1", false, ipv6.dependencies);
  await createPinnedCustomEndpointDispatcher("https://8.8.8.8/v1", false, literal.dependencies);

  assert.equal(ipv6.dispatchers[0]?.address.address, "2606:4700:4700::1111");
  assert.deepEqual(literal.lookups, []);
  assert.equal(literal.dispatchers[0]?.address.address, "8.8.8.8");
});

test("the default dispatcher serves a loopback endpoint when Node requests lookup all", async () => {
  const server = createServer((_request, response) => response.end("pinned"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // An IPv6 listener with the default dual-stack behavior accepts both
    // ::1 and 127.0.0.1, which covers the local resolver's pinned answer.
    server.listen({ host: "::", port: 0 }, resolve);
  });
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const endpoint = `http://localhost:${bound.port}/`;
  const dispatcher = await createPinnedCustomEndpointDispatcher(endpoint, true);

  try {
    const response = await fetch(endpoint, { dispatcher });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pinned");
  } finally {
    await dispatcher.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
