import assert from "node:assert/strict";
import test from "node:test";

import { KeyedWorkSlots, WorkSlots } from "./work-slots.js";

test("refuses the request that would exceed the budget, and gives the slot back", () => {
  const slots = new WorkSlots(2);
  assert.ok(slots.tryAcquire());
  assert.ok(slots.tryAcquire());
  assert.equal(slots.active, 2);
  assert.ok(!slots.tryAcquire(), "the third caller is shed, not queued");
  slots.release();
  assert.equal(slots.active, 1);
  assert.ok(slots.tryAcquire());
});

test("queues a waiter and hands it the slot in order", async () => {
  const slots = new WorkSlots(1);
  const order: string[] = [];
  await slots.acquire();
  order.push("first");
  const second = slots.acquire().then(() => { order.push("second"); });
  const third = slots.acquire().then(() => { order.push("third"); });
  // Neither waiter runs while the only slot is held.
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(order, ["first"]);
  slots.release();
  await second;
  assert.deepEqual(order, ["first", "second"]);
  slots.release();
  await third;
  assert.deepEqual(order, ["first", "second", "third"]);
  slots.release();
  assert.equal(slots.active, 0);
});

test("never lets the counter drift below zero", () => {
  const slots = new WorkSlots(1);
  slots.release();
  assert.equal(slots.active, 0);
  assert.ok(slots.tryAcquire());
  assert.equal(slots.active, 1);
});

/**
 * N-11. An unbounded queue is only bounded by an argument about upload bandwidth;
 * each waiter holds a body already in memory, so the depth has to be in the code.
 */
test("sheds a waiter beyond the queue depth instead of growing without bound", async () => {
  const slots = new WorkSlots(1, 2);
  assert.equal(await slots.acquire(), "acquired");
  const queued = [slots.acquire(), slots.acquire()];
  assert.equal(slots.waiting, 2);
  assert.equal(await slots.acquire(), "shed", "the third waiter is refused, not queued");
  slots.release();
  assert.equal(await queued[0]!, "acquired");
  slots.release();
  assert.equal(await queued[1]!, "acquired");
  slots.release();
  assert.ok(slots.idle);
});

test("gives up on a wait that outlives its deadline, and keeps the slot accounted", async () => {
  const slots = new WorkSlots(1, 4);
  assert.equal(await slots.acquire(), "acquired");
  assert.equal(await slots.acquire(5), "timeout");
  // The waiter that gave up must not be handed the slot later, and must not have
  // consumed the one the holder returns.
  assert.equal(slots.active, 1);
  slots.release();
  assert.equal(slots.active, 0);
  assert.equal(await slots.acquire(5), "acquired");
});

test("hands a freed slot to the waiter ahead of a caller arriving after it", async () => {
  const slots = new WorkSlots(1, 4);
  await slots.acquire();
  const waiter = slots.acquire(1_000);
  // A fresh caller must not overtake the queue while the only slot is still held.
  assert.ok(!slots.tryAcquire());
  slots.release();
  assert.equal(await waiter, "acquired");
  assert.ok(!slots.tryAcquire(), "the slot went to the waiter, not to the newcomer");
  slots.release();
});

test("keys the budget per caller and forgets a key once it falls idle", async () => {
  const slots = new KeyedWorkSlots(2, 1);
  assert.equal(await slots.acquire("a"), "acquired");
  assert.equal(await slots.acquire("a"), "acquired");
  assert.equal(slots.activeFor("a"), 2);
  // A second key is untouched by the first one's flood.
  assert.equal(await slots.acquire("b"), "acquired");
  assert.equal(slots.activeFor("b"), 1);
  // One waiter is allowed for "a", the next is shed.
  const waiting = slots.acquire("a", 1_000);
  assert.equal(await slots.acquire("a", 1_000), "shed");
  slots.release("a");
  assert.equal(await waiting, "acquired");
  slots.release("a");
  slots.release("a");
  slots.release("b");
  assert.equal(slots.keys, 0, "idle pools are dropped");
});

test("bounds the number of keys it remembers", async () => {
  const slots = new KeyedWorkSlots(1, 0, 2);
  assert.equal(await slots.acquire("a"), "acquired");
  assert.equal(await slots.acquire("b"), "acquired");
  assert.equal(slots.keys, 2);
  // A third address forces the map back under its ceiling: no pool is idle, so the
  // oldest is dropped and its holder's accounting is lost — the documented residual
  // of a distributed flood, not a leak.
  assert.equal(await slots.acquire("c"), "acquired");
  assert.equal(slots.keys, 2);
  slots.release("a");
  slots.release("b");
  slots.release("c");
  assert.ok(slots.keys <= 1, `${slots.keys} keys`);
});
