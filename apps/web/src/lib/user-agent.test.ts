import assert from "node:assert/strict";
import { test } from "node:test";
import { describeUserAgent } from "./user-agent.js";

test("reduces a user agent to the browser and the system a reader would recognise", () => {
  assert.equal(
    describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"),
    "Chrome · macOS",
  );
  assert.equal(
    describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"),
    "Firefox · Windows",
  );
  // Edge and Opera also send `Chrome/`; the more specific token has to win.
  assert.equal(
    describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"),
    "Edge · Windows",
  );
  assert.equal(
    describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    "Safari · iOS",
  );
});

test("keeps an unrecognised agent visible but never as a paragraph", () => {
  assert.equal(describeUserAgent("fixture-agent"), "fixture-agent");
  assert.equal(describeUserAgent("z".repeat(120))?.length, 40);
  assert.equal(describeUserAgent(null), null);
  assert.equal(describeUserAgent("   "), null);
});
