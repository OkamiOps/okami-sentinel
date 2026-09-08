import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownHandler, isDraining } from "./shutdown.js";

test("shutdown closes admission, cancels work, waits for escalation and closes storage exactly once", async () => {
  const events: string[] = [];
  const shutdown = createShutdownHandler({
    stopHttp() { assert.equal(isDraining(), true); events.push("http"); },
    cancelWork() { events.push("cancel"); return true; },
    async wait(ms) { assert.equal(ms, 6000); events.push("wait"); },
    closeStore() { events.push("store"); },
  });
  await Promise.all([shutdown(), shutdown()]);
  assert.deepEqual(events, ["http", "cancel", "wait", "store"]);
});
