import assert from "node:assert/strict";
import test from "node:test";
import type { AccountNotificationsResponse } from "@csb/shared";
import { cellKey, cellState, withCell, withCellState } from "./notification-matrix";

function matrix(): AccountNotificationsResponse {
  return {
    address: "ana@okami.test",
    locale: "pt-BR",
    repositories: [
      {
        repositoryKey: "github.com/okami/one", displayName: "sentinel", source: "github", role: "viewer",
        events: [
          { event: "gate.blocked", enabled: true, isDefault: true },
          { event: "gate.passed", enabled: false, isDefault: true },
        ],
      },
      {
        repositoryKey: "local/two", displayName: "bench", source: "local", role: null,
        events: [{ event: "gate.blocked", enabled: true, isDefault: true }],
      },
    ],
    ops: { events: [{ event: "ops.daily_cost", enabled: true, isDefault: true }] },
    unassigned: { events: [{ event: "scan.failed", enabled: true, isDefault: true }] },
    accountEvents: ["account.invite"],
  };
}

test("a toggled cell changes only itself, in the scope it belongs to", () => {
  const before = matrix();
  const after = withCell(before, { scope: "github.com/okami/one", event: "gate.passed" }, true);
  assert.equal(cellState(after, { scope: "github.com/okami/one", event: "gate.passed" })?.enabled, true);
  assert.equal(cellState(after, { scope: "github.com/okami/one", event: "gate.blocked" })?.enabled, true);
  assert.equal(cellState(after, { scope: "local/two", event: "gate.blocked" })?.enabled, true);
  // The previous matrix is the rollback value, so it must not have moved.
  assert.equal(cellState(before, { scope: "github.com/okami/one", event: "gate.passed" })?.enabled, false);
});

test("a cell set back to its default stops claiming it was never touched", () => {
  const after = withCell(matrix(), { scope: "github.com/okami/one", event: "gate.blocked" }, true);
  const cell = cellState(after, { scope: "github.com/okami/one", event: "gate.blocked" });
  assert.equal(cell?.enabled, true);
  assert.equal(cell?.isDefault, false);
});

test("the two reserved scopes are edited by name, and a member's absent row is left alone", () => {
  const ops = withCell(matrix(), { scope: "ops", event: "ops.daily_cost" }, false);
  assert.equal(ops.ops?.events[0].enabled, false);
  assert.equal(ops.unassigned?.events[0].enabled, true);

  const unassigned = withCell(matrix(), { scope: "unassigned", event: "scan.failed" }, false);
  assert.equal(unassigned.unassigned?.events[0].enabled, false);
  assert.equal(unassigned.ops?.events[0].enabled, true);

  const member: AccountNotificationsResponse = { ...matrix(), ops: null, unassigned: null };
  assert.equal(withCell(member, { scope: "ops", event: "ops.daily_cost" }, false).ops, null);
  assert.equal(withCell(member, { scope: "unassigned", event: "scan.failed" }, false).unassigned, null);
});

test("an unknown scope or event is a no-op instead of inventing a row", () => {
  const same = withCell(matrix(), { scope: "github.com/okami/missing", event: "gate.blocked" }, false);
  assert.deepEqual(same, matrix());
  assert.equal(cellState(matrix(), { scope: "github.com/okami/one", event: "scan.completed" }), null);
  assert.equal(cellState(matrix(), { scope: "nope", event: "gate.blocked" }), null);
});

test("a cell key cannot be confused with another scope's", () => {
  assert.notEqual(
    cellKey({ scope: "a", event: "gate.blocked" }),
    cellKey({ scope: "a\u0000gate", event: "gate.blocked" }),
  );
  assert.equal(cellKey({ scope: "ops", event: "ops.daily_cost" }), cellKey({ scope: "ops", event: "ops.daily_cost" }));
});

test("a confirmed cell is taken from the reply without adopting the rest of it", () => {
  // Two toggles in flight: the reply to the first still describes the matrix
  // as it was before the second was written. Adopting it wholesale would flip
  // the second cell back with no error and no way to notice.
  const local = withCell(withCell(matrix(), { scope: "github.com/okami/one", event: "gate.passed" }, true),
    { scope: "local/two", event: "gate.blocked" }, false);
  const staleReply = withCell(matrix(), { scope: "github.com/okami/one", event: "gate.passed" }, true);

  const merged = withCellState(local, { scope: "github.com/okami/one", event: "gate.passed" },
    cellState(staleReply, { scope: "github.com/okami/one", event: "gate.passed" }));

  assert.equal(cellState(merged, { scope: "github.com/okami/one", event: "gate.passed" })?.enabled, true);
  assert.equal(cellState(merged, { scope: "local/two", event: "gate.blocked" })?.enabled, false);
});

test("a rollback restores the one cell's exact previous state, defaults included", () => {
  const before = matrix();
  const cell = { scope: "github.com/okami/one", event: "gate.blocked" } as const;
  const previous = cellState(before, cell);
  const optimistic = withCell(before, cell, false);
  assert.equal(cellState(optimistic, cell)?.isDefault, false);

  const rolled = withCellState(optimistic, cell, previous);
  assert.deepEqual(cellState(rolled, cell), { event: "gate.blocked", enabled: true, isDefault: true });
});

test("a cell the reply no longer carries leaves the matrix alone", () => {
  const before = matrix();
  assert.deepEqual(withCellState(before, { scope: "github.com/okami/one", event: "gate.blocked" }, null), before);
});
