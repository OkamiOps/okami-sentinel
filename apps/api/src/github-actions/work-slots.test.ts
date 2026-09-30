import assert from "node:assert/strict";
import test from "node:test";

import { WorkSlots } from "./work-slots.js";

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
