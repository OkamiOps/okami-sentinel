import type {
  AttackPathModel,
  AttackPathNode,
  AttackPathNodeKind,
  FindingDetail,
} from "@csb/shared";

export type AttackPathInput = Pick<
  FindingDetail,
  "attackPath" | "codeEvidence" | "validation"
>;

type DataRecord = Record<string, unknown>;

const roleKinds: Record<string, AttackPathNodeKind> = {
  attacker: "attacker",
  source: "source",
  entrypoint: "entrypoint",
  concrete_implementation: "implementation",
  implementation: "implementation",
  root_control: "control",
  control: "control",
  sink: "sink",
  evidence: "evidence",
  outcome: "outcome",
};

function record(value: unknown): DataRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as DataRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function kindFromRole(role: string): AttackPathNodeKind {
  return roleKinds[role] ?? "evidence";
}

function kindFromReference(reference: string): AttackPathNodeKind {
  const prefix = reference.replace(/[-_]?\d+$/, "");
  return kindFromRole(prefix);
}

function evidenceNode(
  reference: string,
  item: DataRecord | undefined,
  warnings: Set<string>,
): AttackPathNode {
  if (!item) {
    warnings.add(`Evidence reference not found: ${reference}`);
    return {
      id: reference,
      kind: kindFromReference(reference),
      label: reference.replaceAll("_", " "),
      summary: null,
      evidenceState: "missing",
      evidenceRef: reference,
      location: null,
      code: null,
      language: null,
      explanation: null,
    };
  }

  const role = text(item.role) ?? "evidence";
  const path = text(item.path);
  return {
    id: reference,
    kind: kindFromRole(role),
    label: text(item.label) ?? role.replaceAll("_", " "),
    summary: text(item.explanation),
    evidenceState: "proven",
    evidenceRef: reference,
    location: path
      ? {
          path,
          startLine: number(item.startLine),
          endLine: number(item.endLine),
        }
      : null,
    code: rawText(item.code),
    language: text(item.language),
    explanation: text(item.explanation),
  };
}

function inferredNode(
  id: string,
  kind: AttackPathNodeKind,
  label: string,
  summary: string,
): AttackPathNode {
  return {
    id,
    kind,
    label,
    summary,
    evidenceState: "inferred",
    evidenceRef: null,
    location: null,
    code: null,
    language: null,
    explanation: null,
  };
}

export function normalizeAttackPath(
  input: AttackPathInput,
): AttackPathModel | null {
  const attack = record(input.attackPath);
  const evidenceRows = Array.isArray(input.codeEvidence)
    ? input.codeEvidence
        .map(record)
        .filter((item): item is DataRecord => Boolean(item))
    : [];
  if (!attack && evidenceRows.length === 0) return null;

  const evidence = new Map(
    evidenceRows.map((item, index) => [
      text(item.id) ?? `evidence-${index + 1}`,
      item,
    ]),
  );
  const dataflow = record(attack?.dataflow);
  const reachability = record(attack?.reachability);
  const validation = record(input.validation);
  const warnings = new Set<string>();
  const attacker = text(reachability?.attacker);
  const outcome = text(dataflow?.outcome) ?? text(reachability?.outcome);
  const explicitPaths = Array.isArray(attack?.paths)
    ? attack.paths
        .map(record)
        .filter((item): item is DataRecord => Boolean(item))
    : [];
  const attackRefs = strings(attack?.evidenceRefs);
  const primaryRefs =
    attackRefs.length > 0 ? attackRefs : strings(dataflow?.evidenceRefs);
  const laneSpecs =
    explicitPaths.length > 0
      ? explicitPaths.map((item, index) => ({
          id: text(item.id) ?? `path-${index + 1}`,
          label: text(item.label) ?? `Path ${index + 1}`,
          refs: strings(item.evidenceRefs),
        }))
      : [
          {
            id: "primary",
            label: "Primary path",
            refs: primaryRefs.length > 0 ? primaryRefs : [...evidence.keys()],
          },
        ];

  const lanes = laneSpecs.map((lane) => {
    const nodes = lane.refs.map((reference) =>
      evidenceNode(reference, evidence.get(reference), warnings),
    );
    if (attacker) {
      nodes.unshift(
        inferredNode(`${lane.id}:attacker`, "attacker", "Attacker", attacker),
      );
    }
    if (outcome) {
      nodes.push(
        inferredNode(`${lane.id}:outcome`, "outcome", "Outcome", outcome),
      );
    }
    return { id: lane.id, label: lane.label, nodes };
  });

  const hasCorePath = lanes.every((lane) => {
    const hasEntry = lane.nodes.some(
      (node) =>
        node.evidenceState === "proven" &&
        (node.kind === "source" || node.kind === "entrypoint"),
    );
    const hasSink = lane.nodes.some(
      (node) => node.evidenceState === "proven" && node.kind === "sink",
    );
    return hasEntry && hasSink;
  });
  const hasValidation = Boolean(
    text(validation?.method) ?? text(validation?.summary),
  );
  const allNodes = lanes.flatMap((lane) => lane.nodes);
  const status: AttackPathModel["status"] =
    hasCorePath && hasValidation && warnings.size === 0
      ? "validated"
      : allNodes.length > 0
        ? "partial"
        : "unstructured";
  const impact = record(attack?.impact);
  const likelihood = record(attack?.likelihood);

  return {
    status,
    summary: text(attack?.summary) ?? text(dataflow?.summary),
    preconditions: text(reachability?.preconditions),
    limitations: strings(attack?.limitations),
    impact: {
      level: text(impact?.level),
      rationale: text(impact?.why),
    },
    likelihood: {
      level: text(likelihood?.level),
      rationale: text(likelihood?.why),
    },
    lanes,
    warnings: [...warnings],
  };
}
