import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ROOT_DIR } from "../config.js";
import { normalizeGraph, type GraphIndex } from "./graph-index.js";

export const GRAPHIFY_VERSION = "0.9.51";
const FORMAT = 1;
const MAX_GRAPH_BYTES = 32 * 1_048_576;
export interface GraphPreparation {
  index?: GraphIndex;
  status: "ready" | "unavailable";
  cacheHit: boolean;
  durationMs: number;
  nodes: number;
  edges: number;
  reason?: "runtime_unavailable" | "index_failed";
}
interface Options {
  snapshotRoot: string;
  snapshotId: string;
  signal: AbortSignal;
  executable?: string;
  cacheRoot?: string;
}

export function managedGraphifyExecutable(): string {
  return process.env.CSB_GRAPHIFY_BIN?.trim() || path.join(process.env.CSB_GRAPHIFY_INSTALL_DIR?.trim() || path.join(ROOT_DIR, ".sentinel-tools", "graphify"), "venv",
    process.platform === "win32" ? "Scripts/graphify.exe" : "bin/graphify");
}

export function managedGraphCacheKey(snapshotId: string): string {
  return createHash("sha256").update(JSON.stringify([FORMAT, GRAPHIFY_VERSION, snapshotId, "code-only/no-cluster/1-worker"])).digest("hex");
}

/** Best-effort code-only index. Cancellation still belongs to the scan, never swallowed. */
export async function prepareManagedGraph(options: Options): Promise<GraphPreparation> {
  const started = Date.now();
  const unavailable = (reason: GraphPreparation["reason"]): GraphPreparation => ({ status: "unavailable", cacheHit: false, durationMs: Date.now() - started, nodes: 0, edges: 0, reason });
  options.signal.throwIfAborted();
  const executable = options.executable ?? managedGraphifyExecutable();
  try { await fs.access(executable); } catch { return unavailable("runtime_unavailable"); }
  const cacheRoot = options.cacheRoot ?? path.join(DATA_DIR, "graphify-cache");
  const key = managedGraphCacheKey(options.snapshotId);
  const cacheFile = path.join(cacheRoot, `${key}.json`);
  let temporary: string | undefined;
  try {
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    // Verify the exact managed dependency before trusting a versioned cache key.
    const version = await run(executable, ["--version"], cacheRoot, options.signal);
    if (version.trim() !== `graphify ${GRAPHIFY_VERSION}`) return unavailable("runtime_unavailable");
    const load = async (filename: string): Promise<GraphIndex> => {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GRAPH_BYTES) throw new Error("graph_invalid");
      return normalizeGraph(JSON.parse(await fs.readFile(filename, "utf8")), options.snapshotRoot);
    };
    try {
      const index = await load(cacheFile);
      return { index, status: "ready", cacheHit: true, durationMs: Date.now() - started, nodes: index.nodes.length, edges: index.edges.length };
    } catch { /* Missing or invalid cache is rebuilt from the immutable snapshot. */ }
    temporary = await fs.mkdtemp(path.join(cacheRoot, ".build-"));
    await run(executable, ["extract", path.resolve(options.snapshotRoot), "--code-only", "--force", "--max-workers", "1", "--no-cluster", "--out", temporary], temporary, options.signal);
    options.signal.throwIfAborted();
    const generated = path.join(temporary, "graphify-out", "graph.json");
    const index = await load(generated);
    // Store only normalized relative references, so another snapshot path can reuse it.
    const portable = { nodes: index.nodes.map(node => ({ id: node.id, label: node.label, source_file: node.file, source_location: node.location })), edges: index.edges };
    const published = path.join(temporary, "index.json");
    await fs.writeFile(published, JSON.stringify(portable), { mode: 0o600 });
    await fs.rename(published, cacheFile);
    return { index, status: "ready", cacheHit: false, durationMs: Date.now() - started, nodes: index.nodes.length, edges: index.edges.length };
  } catch {
    options.signal.throwIfAborted();
    return unavailable("index_failed");
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** No provider credentials, user hooks, shell expansion, or inherited Python configuration. */
function run(executable: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd,
      LANG: "C.UTF-8", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
      GRAPHIFY_OUT: "graphify-out", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" };
    if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot;
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let bytes = 0;
    let overflow = false;
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process already exited. */ }
    };
    const collect = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { overflow = true; stop(); return; }
      if (output) stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", () => { signal.removeEventListener("abort", stop); reject(new Error("graphify_process_failed")); });
    child.on("close", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted || overflow || code !== 0) reject(new Error("graphify_process_failed"));
      else resolve(stdout);
    });
    if (signal.aborted) stop();
  });
}
