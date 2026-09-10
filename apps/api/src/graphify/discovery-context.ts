import type { WorkspaceToolHost } from "../agent/session-types.js";
import type { GraphIndex } from "./graph-index.js";
import { buildCandidateGraphContext, type CandidateContextAnchor, type CandidateGraphContext } from "./candidate-context.js";

const sensitive = /auth|permission|credential|token|sanitize|exec|spawn|upload|redirect|write|fetch|request|route/i;

/** Select source-backed entry points, then project their callers and callees.
 * The result is explicitly partial; it must never count as whole-file coverage.
 */
export async function buildDiscoveryGraphContext(index: GraphIndex, paths: readonly string[], host: WorkspaceToolHost): Promise<CandidateGraphContext | null> {
  const anchors: CandidateContextAnchor[] = [];
  for (const file of [...new Set(paths)].slice(0, 8)) {
    const nodes = index.nodes.filter(node => node.file === file && /^L?\d+(?:-L?\d+)?$/.test(node.location))
      .sort((a, b) => Number(sensitive.test(b.label)) - Number(sensitive.test(a.label)) ||
        a.location.localeCompare(b.location, "en", { numeric: true }) || a.id.localeCompare(b.id, "en"));
    const node = nodes[0];
    if (!node) continue;
    const startLine = Number(node.location.replace(/^L/, "").split("-")[0]);
    if (Number.isSafeInteger(startLine) && startLine > 0) anchors.push({ path: file, startLine, endLine: startLine });
  }
  const contexts: CandidateGraphContext[] = [];
  // Two bounded neighborhoods keep early hubs from consuming all source slots.
  for (let offset = 0; offset < anchors.length; offset += 4) {
    const context = await buildCandidateGraphContext(index, anchors.slice(offset, offset + 4), host, 12_288);
    if (context) contexts.push(context);
  }
  if (!contexts.length) return null;
  const windows = contexts.flatMap(context => context.windows).filter((window, i, all) =>
    all.findIndex(other => other.path === window.path && other.startLine === window.startLine && other.endLine === window.endLine) === i);
  return {
    windows,
    eligibleSymbols: contexts.reduce((sum, context) => sum + context.eligibleSymbols, 0),
    omittedSymbols: contexts.reduce((sum, context) => sum + context.omittedSymbols, 0),
    truncated: true,
    traversalTruncated: contexts.some(context => context.traversalTruncated),
    anchorsTruncated: paths.length > 8 || contexts.some(context => context.anchorsTruncated),
    visitedSymbols: contexts.reduce((sum, context) => sum + context.visitedSymbols, 0),
    inspectedEdges: contexts.reduce((sum, context) => sum + context.inspectedEdges, 0),
    note: "Partial source neighborhoods for discovery, not exhaustive coverage or proven data flow. Analyze supplied source first; read missing controls or callers only as needed. Keep partially reviewed files in scope.unexamined, never in scope.inspected solely because excerpts were supplied. Missing graph edges do not establish safety.",
  };
}
