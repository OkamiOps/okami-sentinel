import assert from "node:assert/strict";
import test from "node:test";

import { connectionsLoadState, createMonotonicRequestGuard } from "./connections-page-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function applyWhenLatest<T>(
  beginRequest: () => () => boolean,
  request: Promise<T>,
  onSuccess: (value: T) => void,
  onError: () => void,
) {
  const isLatest = beginRequest();
  try {
    const value = await request;
    if (isLatest()) onSuccess(value);
  } catch {
    if (isLatest()) onError();
  }
}

test("keeps a failed initial connections request out of the loading state", () => {
  assert.equal(connectionsLoadState(null, "Connection routes could not be loaded."), "error");
});

test("keeps successful empty and populated responses distinguishable", () => {
  assert.equal(connectionsLoadState([], null), "empty");
  assert.equal(connectionsLoadState([{ id: "connection-a" }], null), "ready");
});

test("ignores an older failure after the latest request succeeds", async () => {
  const beginRequest = createMonotonicRequestGuard();
  const requestA = deferred<string>();
  const requestB = deferred<string>();
  let result = "loading";

  const loadA = applyWhenLatest(beginRequest, requestA.promise, (value) => { result = value; }, () => { result = "error-a"; });
  const loadB = applyWhenLatest(beginRequest, requestB.promise, (value) => { result = value; }, () => { result = "error-b"; });

  requestB.resolve("success-b");
  await loadB;
  requestA.reject(new Error("late failure"));
  await loadA;

  assert.equal(result, "success-b");
});

test("ignores an older success after the latest request fails", async () => {
  const beginRequest = createMonotonicRequestGuard();
  const requestA = deferred<string>();
  const requestB = deferred<string>();
  let result = "loading";

  const loadA = applyWhenLatest(beginRequest, requestA.promise, (value) => { result = value; }, () => { result = "error-a"; });
  const loadB = applyWhenLatest(beginRequest, requestB.promise, (value) => { result = value; }, () => { result = "error-b"; });

  requestB.reject(new Error("latest failure"));
  await loadB;
  requestA.resolve("stale-success-a");
  await loadA;

  assert.equal(result, "error-b");
});

test("ignores resolve and reject settlements after invalidation", async () => {
  const beginRequest = createMonotonicRequestGuard();
  const resolved = deferred<string>();
  const rejected = deferred<string>();
  let successes = 0;
  let errors = 0;

  const resolveLoad = applyWhenLatest(
    beginRequest,
    resolved.promise,
    () => { successes += 1; },
    () => { errors += 1; },
  );

  beginRequest.invalidate();
  resolved.resolve("late success");
  await resolveLoad;

  const rejectLoad = applyWhenLatest(
    beginRequest,
    rejected.promise,
    () => { successes += 1; },
    () => { errors += 1; },
  );

  beginRequest.invalidate();
  rejected.reject(new Error("late failure"));
  await rejectLoad;

  assert.deepEqual({ successes, errors }, { successes: 0, errors: 0 });
});
