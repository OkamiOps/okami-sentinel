import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsListResponse } from "@csb/shared";
import { assertRepositoryAccess } from "./repository-access.js";
import { repositoryRoots, runtimeMode } from "./deployment-settings.js";

export function listDirectory(requested?: string): FsListResponse {
  const home = os.homedir();
  const target = assertRepositoryAccess(requested?.trim() ||
    (runtimeMode() === "server" ? repositoryRoots()[0] : path.join(home, "Documents", "Git")));

  if (!fs.existsSync(target)) {
    throw new Error(`Caminho não existe: ${target}`);
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new Error(`Não é um diretório: ${target}`);
  }

  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      path: path.join(target, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  let parent: string | null = path.dirname(target);
  try { assertRepositoryAccess(parent); } catch { parent = null; }
  return {
    path: target,
    parent: parent !== target ? parent : null,
    entries,
  };
}
