import type { MaterializationLeaseMetadata } from "../gate-store.js";
import { cleanupMaterializationLeaseRoot } from "./snapshot-materializer.js";

export interface MaterializationReconcilerStore {
  list(): MaterializationLeaseMetadata[];
  save(lease: MaterializationLeaseMetadata): void;
}

export interface MaterializationReconciliation {
  released: string[];
  retryable: string[];
}

export function reconcileMaterializationLeases(
  root: string,
  store: MaterializationReconcilerStore,
  now: () => Date = () => new Date(),
): MaterializationReconciliation {
  const released: string[] = [];
  const retryable: string[] = [];
  for (const lease of store.list()) {
    if (lease.state === "released" && lease.releasedAt !== null) continue;
    try {
      cleanupMaterializationLeaseRoot(root, lease.gateId, lease.id);
      store.save({
        ...lease,
        state: "released",
        releasedAt: now().toISOString(),
      });
      released.push(lease.id);
    } catch {
      store.save({ ...lease, state: "failed", releasedAt: null });
      retryable.push(lease.id);
    }
  }
  return { released, retryable };
}
