# Portable graph planning, context and recovery

Applies to Codex Security Portable in pnpm and server/Docker installations.
Native Codex Security, Mantis and VulnHunter retain their existing executors.

## Graph integration

The immutable snapshot remains the authority. Deep enumerates the same complete
auditable universe, then greedily packs files by accumulated EXTRACTED file-edge
affinity under the existing 32-file/128-KiB targets (oversized singleton preserved).
Files absent from the graph are retained. INFERRED edges do not drive packing.
`portable-deep-plan.json` binds the ordered partitions and digest to the snapshot;
recovery validates membership, uniqueness, sizes and limits without recomputing
the graph layout. Runs without a saved plan use their legacy lexical layout.

Standard discovery receives a navigation map of up to 12 files/8 KiB, ranked by
extracted cross-file connections and security-related names, with directory diversity.
The initial pass does not exclude inventory paths; the complementary pass excludes
already inspected exact paths from suggestions only. Neither map restricts allowed
inspection nor counts as source evidence. Tests remain available for verification.

Assessment contexts traverse EXTRACTED calls up to three steps in both directions,
with explicit paths (including reverse caller steps), at most 8 windows/16 KiB per
page. Traversal is bounded to 1,024 symbols and 4,096 edges, shared among anchors;
related windows are selected round-robin so eight anchors cannot consume every slot.
Control-related names prioritize navigation but do not prove effective controls.
Intermediate path references are not source excerpts and may require further reads. Graphify point-only
locations use the next source symbol as a navigation heuristic, explicitly labeled.
They are not verified function extents, control-flow or vulnerability proof.
Source is read through the pinned workspace host. Missing/invalid windows remain
omitted explicitly, and normal source inspection remains available.

`workspace.read` accepts paired inclusive `startLine`/`endLine` (maximum 400 lines).
Full-file behavior remains unchanged; partial reads never satisfy full discovery
coverage. Telemetry reports plan size, discovery priorities, graph context windows/bytes,
visited symbols, inspected edges and traversal/output truncation.

## Context and artifact failures

Portable sets `limits.maxContextTokens` to the smaller of 300,000 tokens and the published model context.
Before each upstream request, the estimator includes serialized instructions,
tools, message history and completion capacity. Initial density is conservatively
two UTF-8 bytes per token with protocol margin; reported usage can increase it.
Responses continuations include carried remote context and new request content.
Unknown completion caps reserve 64K. This is an estimated-context guard, not a
provider tokenizer guarantee or universal long-context pricing threshold.

The session never silently drops evidence/history. `agent_context_limit` requests
a fresh, smaller unit through recovery. Three identical rejected artifact writes
terminate with `agent_artifact_stalled`. The comparison hash stays in memory;
logs contain no rejected payload. Assessment errors identify the validated
candidate ID, structural field and a closed evidence requirement code. Repairs
must not invent evidence or turn uncertainty into a confirmation.

## Durable recovery

`portable-recovery/` is outside exact stage artifact directories. Per-page journals
bind snapshot/stage/page and count each attempt before dispatch. At most three page
attempts are permitted (initial plus two); this is not a three-model-request cap.
Recoverable context/byte/turn/tool/invalid-artifact failures start fresh histories.
Multi-file discovery and multi-candidate assessment/report pages split into single
units on retry. Accepted child artifacts are verified and reused across subsequent
attempts. Parent artifacts are assembled only after all children validate; exact
duplicate candidate IDs merge, conflicting claims fail closed. Usage accumulates
across failures and configured cost ceilings remain enforced.

Authentication, cancellation, cost limits and unknown/protocol errors are not
blindly repeated. A singleton that still cannot fit or produce valid evidence
eventually exhausts its recovery budget and remains incomplete/failed. No elapsed
scan timeout is introduced. Manual recovery copies child checkpoints and journals,
not stale session locks, while preserving the immutable source and plan.

Server startup captures previously active run IDs before reconciliation. It can
resume only those now incomplete with nonterminal runtime, validated prerequisite
checkpoints and no live worker. Capacity reservation and a database claim prevent
duplicate launches; the selected connection is probed again. Recovery retains the
same ID, cost state and snapshot, and allows at most two server restart attempts.
Only verified dead-worker, empty hash-named locks are removed. Explicit cancellations
and terminal errors are not auto-restarted. Missing early checkpoints, unavailable
credentials/capacity or an exhausted budget require operator action. Local desktop
mode retains its existing reconciliation behavior.

## Verification boundaries

Offline frozen-snapshot packing preserved 508 files / 5,737,867 bytes, reduced 47 pages
to 42 and cross-page graph edges from 6,600 to 5,808. This measures locality, not model speed
or recall. A source-window probe recovered `confinedPath` from its calling anchor.
Automated tests inject validation/report failures, verify child reuse, persistent
budgets, source protection, context limits and cancellation. A disposable real Node
worker crash test verifies same-ID coordination and checkpoint hash preservation;
it does not replace a Docker/provider end-to-end test or a paid scan comparison.

## Standard discovery recovery

A recoverable failure in Standard discovery (including the complementary pass)
now changes strategy: at most 12 deterministic source targets, prioritized through
the graph when available, are processed as individual projected-source units.
Each gets a fresh history, at most 16 turns and 64 tool calls (or smaller configured
limits). This is targeted Standard inspection, not Deep or whole-repository coverage.
Accepted candidates remain immutable, completed units are reused, and the existing
three-attempt page budget remains enforced. `standard_recovery_plan` reports this
strategy. All units must validate before the stage advances; exhausted recovery is
still a failure, never a successful empty report. Authentication and cost failures
remain terminal. Discovery repair instructions explicitly prohibit rewriting carried
candidate IDs with changed content.
