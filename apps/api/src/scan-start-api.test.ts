import assert from "node:assert/strict";
import test from "node:test";

import { createScanStartApp } from "./scan-start-api.js";

function withTestDeadline<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("test_deadline_exceeded")), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

test("POST /scans forwards request abort through a hung preflight before output or child", async () => {
  let vaultReads = 0;
  let outputWrites = 0;
  let childStarts = 0;
  let markPreflightStarted!: () => void;
  const preflightStarted = new Promise<void>((resolve) => {
    markPreflightStarted = resolve;
  });
  const api = createScanStartApp({
    async startScan(_request, options = {}) {
      vaultReads += 1;
      markPreflightStarted();
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => reject(new Error("credential_unavailable"));
        if (options.signal?.aborted) {
          fail();
          return;
        }
        options.signal?.addEventListener("abort", fail, { once: true });
      });
      outputWrites += 1;
      childStarts += 1;
      throw new Error("unreachable");
    },
  });
  const controller = new AbortController();
  const responsePromise = Promise.resolve(
    api.request("http://localhost/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath: "/repo", engine: "codex-security" }),
      signal: controller.signal,
    }),
  );

  await preflightStarted;
  controller.abort();
  const response = await withTestDeadline(responsePromise);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "credential_unavailable" });
  assert.equal(vaultReads, 1);
  assert.equal(outputWrites, 0);
  assert.equal(childStarts, 0);
});
