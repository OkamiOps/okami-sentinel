import assert from "node:assert/strict";
import test from "node:test";
import { localApiHost } from "./api-host.js";

test("local API accepts literal loopback addresses and normalizes localhost", () => {
  for (const input of [undefined, "", "  ", "localhost", "127.0.0.1"]) assert.equal(localApiHost(input), "127.0.0.1");
  assert.equal(localApiHost("127.1.2.3"), "127.1.2.3");
  assert.equal(localApiHost("[::1]"), "::1");
  assert.equal(localApiHost("::1"), "::1");
});

test("local API rejects wildcard, private, public, malformed, and DNS bind targets", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.1", "10.0.0.1", "203.0.113.1", "127.999.0.1", "127.0.0.1.example.com", "host.example.com"]) {
    assert.throws(() => localApiHost(host), /loopback/);
  }
});
