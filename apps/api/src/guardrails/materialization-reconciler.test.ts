import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MaterializationLeaseMetadata } from "../gate-store.js";
import { reconcileMaterializationLeases } from "./materialization-reconciler.js";

test("startup reconciliation releases orphaned snapshot roots and preserves no physical path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-lease-reconcile-"));
  const lease = fixture();
  const leaseRoot = path.join(root, `${lease.gateId}--${lease.id}`);
  fs.mkdirSync(leaseRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(leaseRoot, "snapshot"), "private", { mode: 0o400 });
  fs.chmodSync(leaseRoot, 0o500);
  const saved: MaterializationLeaseMetadata[] = [];
  try {
    const result = reconcileMaterializationLeases(root, {
      list: () => [lease],
      save: (value) => saved.push(value),
    }, () => new Date("2026-08-12T13:00:00.000Z"));

    assert.deepEqual(result, { released: ["lease-1"], retryable: [] });
    assert.equal(fs.existsSync(leaseRoot), false);
    assert.equal(saved.at(-1)?.state, "released");
    assert.equal(JSON.stringify(saved).includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure remains visible and retryable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-lease-reconcile-"));
  const lease = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "csb-lease-outside-"));
  const leaseRoot = path.join(root, `${lease.gateId}--${lease.id}`);
  fs.symlinkSync(outside, leaseRoot);
  const saved: MaterializationLeaseMetadata[] = [];
  try {
    const result = reconcileMaterializationLeases(root, {
      list: () => [lease],
      save: (value) => saved.push(value),
    });
    assert.deepEqual(result, { released: [], retryable: ["lease-1"] });
    assert.equal(saved.at(-1)?.state, "failed");
    assert.equal(saved.at(-1)?.releasedAt, null);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.unlinkSync(leaseRoot);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

function fixture(): MaterializationLeaseMetadata {
  return {
    id: "lease-1",
    gateId: "gate-1",
    repositoryKey: "github:991122",
    snapshotIdentity: `sha256:${"d".repeat(64)}`,
    state: "ready",
    createdAt: "2026-08-12T12:00:00.000Z",
    expiresAt: "2026-08-12T14:00:00.000Z",
    releasedAt: null,
  };
}
