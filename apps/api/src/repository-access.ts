import fs from "node:fs";
import path from "node:path";
import { repositoryRoots, runtimeMode } from "./deployment-settings.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Realpaths exclude symlink escapes; callers receive the pinned canonical path. */
export function assertRepositoryAccess(requested: string, options: {
  roots?: string[];
  mode?: "local" | "server";
  managedRoot?: string;
} = {}): string {
  if (typeof requested !== "string" || !requested.trim() || requested.includes("\0")) throw new Error("repository_path_invalid");
  const target = path.resolve(requested);
  if ((options.mode ?? runtimeMode()) === "local") return target;
  let canonical: string;
  try { canonical = fs.realpathSync(target); } catch { throw new Error("repository_path_unavailable"); }
  const roots = options.managedRoot ? [options.managedRoot] : options.roots ?? repositoryRoots();
  if (!roots.some((root) => {
    try { return inside(fs.realpathSync(root), canonical); } catch { return false; }
  })) throw new Error("repository_path_denied");
  return canonical;
}
