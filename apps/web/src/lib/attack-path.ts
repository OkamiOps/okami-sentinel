import type {
  AttackPathLane,
  AttackPathModel,
  AttackPathNode,
} from "@csb/shared";

export type AttackPathStageItem =
  | { type: "node"; node: AttackPathNode }
  | { type: "collapsed"; id: string; count: number };

export function getAttackPathSelection(
  model: AttackPathModel,
  laneId?: string | null,
  nodeId?: string | null,
): { lane: AttackPathLane; node: AttackPathNode | null } {
  const lane =
    model.lanes.find((candidate) => candidate.id === laneId) ?? model.lanes[0];
  if (!lane) {
    throw new Error("Attack path model has no lanes");
  }
  const node =
    lane.nodes.find((candidate) => candidate.id === nodeId) ??
    lane.nodes.find((candidate) => candidate.evidenceState === "proven") ??
    lane.nodes[0] ??
    null;
  return { lane, node };
}

export function getAttackPathStageItems(
  lane: AttackPathLane,
  compact = false,
): AttackPathStageItem[] {
  if (!compact || lane.nodes.length <= 5) {
    return lane.nodes.map((node) => ({ type: "node", node }));
  }
  const visibleKinds = new Set<AttackPathNode["kind"]>([
    "attacker",
    "source",
    "control",
    "sink",
    "outcome",
  ]);
  const visibleIndexes = new Set<number>([0, lane.nodes.length - 1]);
  lane.nodes.forEach((node, index) => {
    if (visibleKinds.has(node.kind) || node.evidenceState === "missing") {
      visibleIndexes.add(index);
    }
  });

  const items: AttackPathStageItem[] = [];
  let hiddenStart: number | null = null;
  lane.nodes.forEach((node, index) => {
    if (!visibleIndexes.has(index)) {
      hiddenStart ??= index;
      return;
    }
    if (hiddenStart != null) {
      items.push({
        type: "collapsed",
        id: `${lane.id}:collapsed:${hiddenStart}`,
        count: index - hiddenStart,
      });
      hiddenStart = null;
    }
    items.push({ type: "node", node });
  });
  if (hiddenStart != null) {
    items.push({
      type: "collapsed",
      id: `${lane.id}:collapsed:${hiddenStart}`,
      count: lane.nodes.length - hiddenStart,
    });
  }
  return items;
}

export function attackPathHref({
  scanId,
  findingId,
  evidenceScanId,
  laneId,
  nodeId,
}: {
  scanId: string;
  findingId: string;
  evidenceScanId?: string | null;
  laneId?: string | null;
  nodeId?: string | null;
}): string {
  const query = new URLSearchParams();
  if (evidenceScanId && evidenceScanId !== scanId) {
    query.set("evidenceScan", evidenceScanId);
  }
  if (laneId) query.set("lane", laneId);
  if (nodeId) query.set("node", nodeId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/scans/${encodeURIComponent(scanId)}/findings/${encodeURIComponent(findingId)}/path${suffix}`;
}
