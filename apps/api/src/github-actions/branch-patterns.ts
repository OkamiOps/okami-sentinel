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
  return compile(trimmedPattern).test(name);
}

export function matchesAnyBranchPattern(patterns: readonly string[], branch: string): boolean {
  return patterns.some((pattern) => matchesBranchPattern(pattern, branch));
}

const compiled = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const known = compiled.get(pattern);
  if (known) return known;
  // Split on the stars first so the literal parts can be escaped wholesale; the
  // separators are then translated one by one.
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".+" : part === "*" ? "[^/]+" : escapeRegExp(part)))
    .join("");
  const expression = new RegExp(`^${source}$`);
  // Patterns come from a bounded list on an action row (1..20), so the cache is
  // bounded in practice; the guard is there for a pathological caller.
  if (compiled.size > 1000) compiled.clear();
  compiled.set(pattern, expression);
  return expression;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
