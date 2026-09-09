import fs from "node:fs";
import path from "node:path";
import type { ScanRun, ScanAnalysisMetrics } from "@csb/shared";
import { readCliLogSnapshot } from "./activity.js";
import { createPortableDeepCoveragePlan } from "./scanners/portable-codex-security-deep-coverage.js";

const cache = new Map<string, { at: number; value: ScanAnalysisMetrics }>();

/** Reads immutable scan inputs and persisted events; never asks the model for metrics. */
export function scanAnalysisMetrics(scan: ScanRun, now = Date.now()): ScanAnalysisMetrics {
  const key = scan.scanDir;
  const cached = cache.get(key);
  if (cached && now - cached.at < 15_000) return cached.value;
  const result: ScanAnalysisMetrics = {
    measuredAt: new Date(now).toISOString(), files: null, bytes: null, lines: null,
    batchesCompleted: null, batchesTotal: null, candidates: null,
    rejections: null, reasoningTokens: null, outputTokensPerSecond: null,
  };
  if (scan.execution?.executionProfile === "portable" && scan.engine === "codex-security") {
    try {
      const root = path.join(scan.scanDir, "portable-codex-security-snapshot");
      const plan = createPortableDeepCoveragePlan(root);
      result.files = plan.files.length;
      result.bytes = plan.totalBytes;
      result.lines = plan.files.reduce((total, file) => {
        const text = fs.readFileSync(path.join(root, file), "utf8");
        return total + (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
      }, 0);
      const artifacts = path.join(scan.scanDir, "portable-codex-security-artifacts");
      const dirs = fs.readdirSync(artifacts).filter((name) =>
        /^discovery(?:-\d+)?$/.test(name) || (scan.mode === "standard" && name === "discovery-review")
      );
      let completed = 0;
      const candidateIds = new Set<string>();
      for (const dir of dirs) {
        try {
          const value = JSON.parse(fs.readFileSync(path.join(artifacts, dir, "03-discovery.json"), "utf8"));
          if (value.stage !== "discovery" || !Array.isArray(value.candidates)) continue;
          completed += 1;
          for (const candidate of value.candidates) {
            if (candidate && typeof candidate === "object" && typeof candidate.id === "string") {
              candidateIds.add(candidate.id);
            }
          }
        } catch { /* A worker may not have finished its atomic artifact write yet. */ }
      }
      result.batchesTotal = scan.mode === "deep" ? plan.partitions.length
        : dirs.includes("discovery-review") ? 2 : 1;
      result.batchesCompleted = completed;
      result.candidates = candidateIds.size;
    } catch { /* Missing legacy snapshots remain unavailable, not zero. */ }
  }
  const durableLog = path.join(scan.scanDir, "portable-worker-events.log");
  const history = fs.existsSync(durableLog)
    ? { lines: fs.readFileSync(durableLog, "utf8").split("\n"), cursor: fs.statSync(durableLog).size }
    : readCliLogSnapshot(scan.scanDir, Number.MAX_SAFE_INTEGER);
  if (history.cursor > 0) {
    const rejected = new Set<string>();
    let reasoning = 0;
    let reasoningKnown = false;
    for (const line of history.lines) {
      if (!line.startsWith("[stdout] {")) continue;
      try {
        const event = JSON.parse(line.slice(9));
        if (event.type === "tool" && event.phase === "result" && event.name === "results.write" && event.ok === false && typeof event.callId === "string") rejected.add(event.callId);
        if (event.type === "usage" && Number.isFinite(event.usage?.reasoningTokens) && event.usage.reasoningTokens >= 0) {
          reasoningKnown = true;
          reasoning += event.usage.reasoningTokens;
        }
      } catch { /* Ignore partial/non-structured lines. */ }
    }
    result.rejections = rejected.size;
    result.reasoningTokens = reasoningKnown ? reasoning : null;
  }
  const seconds = ((scan.completedAt ? Date.parse(scan.completedAt) : now) - (scan.startedAt ? Date.parse(scan.startedAt) : NaN)) / 1000;
  if ((scan.completedAt || scan.status === "running" || scan.status === "queued") && seconds > 0 && scan.usage?.outputTokens != null) result.outputTokensPerSecond = scan.usage.outputTokens / seconds;
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, value: result });
  return result;
}
