# Portable graph planning, context and recovery

Applies to Codex Security Portable in pnpm and server/Docker installations.
Native Codex Security, Mantis and VulnHunter retain their existing executors.

## Complete Standard and Deep coverage

New full Standard scans enumerate the same auditable source/configuration universe as
Deep, independently of graph membership or priority scores. The graph changes batch
locality, never membership. Every batch projects every assigned file's complete source.
Standard uses an overview-first review with at most 16 model turns per discovery
batch; Deep uses its deeper exploration allowance. These per-session limits constrain
investigation depth and context, never how many files are included. Source absent
from the graph is still assigned. Missing or failed batches prevent completion.

The depth distinction also applies to dataflow and validation. Standard resolves the
concrete candidate through its main caller/control/sink path, fetching any decisive
missing source. Deep additionally investigates relevant alternate callers, control
ordering, bypass hypotheses, transformations and state/deployment prerequisites.
Both require the same evidence to confirm a finding. Reporting synthesizes accepted
evidence in both modes and never starts another discovery pass.

Performance acceptance targets for the benchmark are at most 90 minutes for Standard
and five hours for Deep, including recovery. These are measurement targets, not new
timeouts or permission to skip code. Compare fresh independent runs on the same
snapshot/model using elapsed time, completed batches/files, validated distinct findings,
input/cache/output tokens and recovery overhead. Full source projection demonstrates
coverage availability, not model attention, detection quality or achieved speed.
The revised full-coverage modes still require that real-run performance validation.

Completion ceilings must reach the provider wire request on every turn: OpenAI and
OpenRouter chat use `max_completion_tokens`, other chat-compatible routes use
`max_tokens`, and Responses uses `max_output_tokens`. Session validation alone does
not enforce generation length. The context guard includes this wire output reserve.
These ceilings do not replace mode-specific reasoning controls or prove latency gains;
provider truncation must not be interpreted as a successful empty scan.

Responses uses strict function schemas for concrete Portable stages. Every declared
nested property is required on the wire, including explanatory anchor fields, so
the provider receives a strict-compatible schema instead of an optional mixed-stage
shape. This narrows generated structure only: local source, coverage, candidate and
evidence validation remains authoritative. Legacy calls without a concrete stage
retain their optional union schema; other protocol adapters are unchanged.

Responses transports put the complete task/source in one persistent system input
item. They do not duplicate it in both top-level `instructions` and user input;
continuations carry tool outputs and concise control messages. For direct xAI
`grok-4.6`, missing catalog reasoning metadata is supplemented from the official
model documentation; explicit metadata always wins. New scans select `low` for
Standard and `high` for Deep when supported by the resolved route. Explicit valid
user choices are preserved. If the mode preference is unavailable, the route's
published default applies; without effort metadata the parameter is omitted.
The effective choice is recorded as sent effort, not hidden behind provider default.

Standard persists `portable-standard-plan.json`, binding membership, order and sizes
to the immutable snapshot. Checkpoint recovery reuses accepted batches and examines
only remaining work in that same scan. This is not incremental scanning and does not
import findings from any other scan. Oversized/unsupported input fails explicitly
under the existing snapshot/source policies rather than silently dropping code.

Complete pages also receive bounded cross-file graph navigation references; omitted
references can be queried and do not remove source coverage. Validation must inspect
available missing callers/controls before using insufficient-evidence to reject a lead.

The historical two-pass/sample Standard behavior below is retained only for resuming
old Standard runs without a persisted complete plan. New Standard scans do not use
that sampling or its 12-target recovery fallback.

## Graph integration

The immutable snapshot remains the authority. Deep enumerates the same complete
auditable universe, then greedily packs files by accumulated EXTRACTED file-edge
affinity under the existing 32-file/128-KiB targets (oversized singleton preserved).
Files absent from the graph are retained. INFERRED edges do not drive packing.
`portable-deep-plan.json` binds the ordered partitions and digest to the snapshot;
recovery validates membership, uniqueness, sizes and limits without recomputing
the graph layout. Runs without a saved plan use their legacy lexical layout.

Legacy Standard discovery receives a navigation map of up to 12 files/8 KiB, ranked by
extracted cross-file connections and security-related names, with directory diversity.
The initial pass does not exclude inventory paths; the complementary pass excludes
already inspected exact paths from suggestions only. Neither map restricts allowed
inspection nor counts as source evidence. Tests remain available for verification.

Legacy Standard also projects actual source neighborhoods before discovery: up to eight
seed paths, two bounded EXTRACTED caller/callee traversals and at most 24 KiB of
source/context. The complementary pass rotates paths already projected by the initial
pass as navigation hints only. Partial excerpts remain `scope.unexamined` with
`insufficient-evidence`; only successful full reads count as `scope.inspected`.
A nonempty server projection permits an empty inspected list, without manufacturing
coverage. Missing source and unresolved controls remain available through workspace tools.
The carried dossier is rendered as untrusted JSON, rather than asking the model to
reconstruct Base64. Persistent dossier transport remains unchanged.

Legacy sampled Standard recovery plans pin `sourceProjection: graph-windows-v1`. They group up to
12 target paths into at most three four-path neighborhoods instead of 12 whole-file
sessions. Empty projections still name the assigned paths for directed source reads.
Each accepted group is checkpointed; later retries reuse it. Legacy saved plans retain
their original full-file behavior and layout. Missing Graphify on a saved graph plan
fails explicitly rather than silently changing the recovery contract. Partial coverage
survives group aggregation.

Candidate rejection telemetry includes the structural reason and item index, never
the rejected source or claim. Candidate narrative bounds are stated in UTF-8 bytes
in both the tool schema and prompt. Historic generic rejection events cannot establish
which field failed; improved diagnostics apply to new sessions.


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
units on retry. Oversized discovery files, including singleton batches, split into
consecutive source slices bounded by 64 KiB of JSON-encoded content. Slices preserve
Unicode, all source characters and original line/column coordinates; large single
lines are split rather than omitted. Their versioned child checkpoint layout is
deterministic. A slice is internal partial work, never full-file completion: all
slices must validate before the parent artifact can claim the file inspected.
Accepted child artifacts are verified and reused across subsequent
attempts. Parent artifacts are assembled only after all children validate; exact
duplicate candidate IDs merge, conflicting claims fail closed. Usage accumulates
across failures and configured cost ceilings remain enforced.

Inference transport retries network/408/429/5xx failures at most twice, with
abortable 1s/2s backoff, within the current model turn. It does not replay local
tools or stage checkpoints. A lost response may still have incurred provider
usage, so transport retries cannot guarantee zero additional inference cost.
Authentication, cancellation, cost limits and unknown/protocol errors are not
blindly repeated. A singleton that still cannot fit or produce valid evidence
eventually exhausts its recovery budget and remains incomplete/failed. No elapsed
scan timeout is introduced. Manual recovery copies child checkpoints and journals,
not stale session locks, while preserving the immutable source and plan.

Startup and periodic reconciliation capture previously active run IDs before reconciliation. The runner also schedules recovery after an interrupted child closes, only after releasing its capacity and process identity. Both local and server modes use this protocol. It can
resume only those now incomplete with nonterminal runtime, validated prerequisite
checkpoints and no live worker. Capacity reservation and a database claim prevent
duplicate launches; the selected connection is probed again. Recovery retains the
same ID, cost state and snapshot, and allows at most two automatic worker restart attempts.
Only verified dead-worker, empty hash-named locks are removed. Explicit cancellations
and terminal errors are not auto-restarted. Missing early checkpoints, unavailable
credentials/capacity or an exhausted budget stop recovery explicitly. Automatic recovery does not modify an exhausted journal or restart historical terminal scans.

## Verification boundaries

Offline frozen-snapshot packing preserved 508 files / 5,737,867 bytes, reduced 47 pages
to 42 and cross-page graph edges from 6,600 to 5,808. This measures locality, not model speed
or recall. A source-window probe recovered `confinedPath` from its calling anchor.
Automated tests inject validation/report failures, verify child reuse, persistent
budgets, source protection, context limits and cancellation. A disposable real Node
worker crash test verifies same-ID coordination and checkpoint hash preservation;
it does not replace a Docker/provider end-to-end test or a paid scan comparison.

## Legacy sampled Standard discovery recovery

A recoverable failure in Standard discovery (including the complementary pass)
now changes strategy: at most 12 deterministic source targets, prioritized through
the graph when available, are processed as three groups of up to four source
neighborhoods with Graphify. Legacy/no-graph plans retain individual full-source units.
Each gets a fresh history, at most 16 turns and 64 tool calls (or smaller configured
limits). This is targeted Standard inspection, not Deep or whole-repository coverage.
Accepted candidates remain immutable, completed units are reused, and the existing
three-attempt page budget remains enforced. `standard_recovery_plan` reports this
strategy. All units must validate before the stage advances; exhausted recovery is
still a failure, never a successful empty report. Authentication and cost failures
remain terminal. Discovery repair instructions explicitly prohibit rewriting carried
candidate IDs with changed content.

## Avoiding duplicate navigation

Actual snapshot windows supplied to assessment stages can be inspected directly:
there is no mandatory tool round-trip when source is already projected. The model
must independently assess that code, rather than trust candidate claims or graph
relationships. Missing ranges and unresolved callers/controls still require source
inspection; excerpts never imply complete-file coverage. Known unresolved call
relationships are directed to an exact graph lookup before repository-wide search.

Report pages receive bounded source windows selected from confirmed validation
anchors when the graph can locate them. Reporting exposes only workspace.read and
results.write: it synthesizes the validated dossier and reads precise missing ranges,
without directory listing or discovery searches. If no source windows are available,
a source read remains required. Existing candidate, coverage, severity and anchor
validation remains authoritative. Complementary graph hints omit already inspected
paths from both suggested files and related-file lists, without denying needed reads.

These changes remove redundant workflow instructions; real provider runtime and
finding-quality improvements still require measurement.

## Productive actions and loop guidance

Standard and Deep sessions use `maxToolCalls: 0` and `maxModelTurns: 0`, with no `artifactWriteByTurn`. The shared runner interprets zero as disabling cumulative action ceilings, including forced-finalization reserves derived from those counts. Mode-specific prompts and reasoning effort distinguish breadth from depth. Explicitly bounded capability probes retain their limits.

Inspection progress tracking stores only bounded hashes of tool inputs and original results. New successful evidence resets stagnation. Three consecutive already-seen results or failed inspections trigger model-visible guidance to reuse evidence, correct arguments or follow a different relevant relationship; no action is blocked by this advisory. Cyclic repetitions are detected as well as identical consecutive calls. Source, graph and tool-result content remain untrusted. Artifact repair has its separate validation/stall handling.

Context, input/output byte budgets, configured consumption controls, cancellation and evidence checks remain in force. This change does not introduce a duration timeout. An already-running worker retains its loaded policy until restarted; an operator update restart must be identified separately from spontaneous recovery.


### Assessment source projection

Dataflow, validation and report prefetch allocation is calculated after building the complete stage prompt, including the dossier and assessment instructions. It uses the smaller of the provider context window and 300,000 tokens, the existing conservative context estimator, the completion reserve (explicit cap or 65,536), a 16,384-token protocol/tool-schema allowance, and one quarter of the context for subsequent tool results/history. Protocol/schema capacity is an allowance, not an exact tokenizer measurement; the actual serialized-wire guard remains authoritative.

Adaptive projection has no fixed 192 KiB cap, window count or 240-line function cutoff. Source is read across transport-sized ranges for complete selected symbols; shared graph symbols are deduplicated. Anchor symbols precede round-robin related symbols. Projection never extends scan coverage: pending source ranges remain explicit and the agent is instructed to inspect relevant missing ranges using its normal tools. Traversal remains bounded against pathological graphs and truncation remains marked. Discovery retains its separate policy.

Tests verify full projection of 60 functions of 500 lines, smaller-budget pending ranges, and reduced allocation for larger prompts, smaller provider windows and larger response reserves. This does not establish latency, cost or finding-quality gains; those require a new model execution. Already-running workers retain their loaded code.
