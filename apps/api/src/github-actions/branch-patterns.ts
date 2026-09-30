import { shortBranchName } from "./schema.js";

/**
 * The branch-pattern language of an action, one meaning for both trigger kinds:
 * a `pull_request` action matches the PR's `base.ref`, a `push` action matches
 * the short name of the pushed `ref`.
 *
 * - `*` matches one or more characters **inside a single segment**, so
 *   `release/*` covers `release/9` and not `release/9/rc1`;
 * - `**` matches across segments, so `release/**` covers both;
 * - everything else is literal, metacharacters included.
 *
 * The legacy monitor matcher turned every `*` into `.*`, which made `release/*`
 * silently cover the whole subtree. The spec asks for the two-star distinction,
 * so this is a deliberate narrowing of the old behaviour.
 */
export function matchesBranchPattern(pattern: string, branch: string): boolean {
  const trimmedPattern = pattern.trim();
  const name = shortBranchName(branch.trim());
  if (trimmedPattern === "" || name === "") return false;
  return compile(trimmedPattern)?.test(name) ?? false;
}

export function matchesAnyBranchPattern(patterns: readonly string[], branch: string): boolean {
  return patterns.some((pattern) => matchesBranchPattern(pattern, branch));
}

/**
 * Two wildcards express everything the documented language needs
 * (`release/**`, `feature/*`, `*-hotfix`). A chain of them separated by literals
 * is polynomial backtracking against a branch name any contributor can choose, so
 * beyond this bound the pattern matches nothing at all rather than burning the
 * event loop. The write path (task 1.5) should refuse such a pattern outright.
 */
export const MAX_BRANCH_PATTERN_WILDCARDS = 4;
const MAX_WILDCARDS = MAX_BRANCH_PATTERN_WILDCARDS;

/**
 * How many wildcards a pattern compiles to, counted exactly as `compile` counts
 * them: a run of three or more stars collapses to `**`, so `***` is one. The
 * write path uses this to refuse a pattern that would match nothing, instead of
 * storing one that silently never fires.
 */
export function branchPatternWildcards(pattern: string): number {
  return pattern.trim().replaceAll(/\*{3,}/g, "**").split(/(\*\*|\*)/)
    .filter((part) => part === "**" || part === "*").length;
}

const compiled = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  const known = compiled.get(pattern);
  if (known !== undefined) return known;
  // Split on the stars first so the literal parts can be escaped wholesale; the
  // separators are then translated one by one. A run of three or more stars means
  // no more than `**` does, so it collapses instead of compiling two wildcards.
  const parts = pattern.replaceAll(/\*{3,}/g, "**").split(/(\*\*|\*)/);
  const wildcards = parts.filter((part) => part === "**" || part === "*").length;
  const source = wildcards > MAX_WILDCARDS
    ? null
    : parts
      .map((part) => (part === "**" ? ".+" : part === "*" ? "[^/]+" : escapeRegExp(part)))
      .join("");
  const expression = source === null ? null : new RegExp(`^${source}$`);
  // Patterns come from a bounded list on an action row (1..20), so the cache is
  // bounded in practice; the guard is there for a pathological caller.
  if (compiled.size > 1000) compiled.clear();
  compiled.set(pattern, expression);
  return expression;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
