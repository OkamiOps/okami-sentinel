import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recoverCodexSessionUsage } from "./ingest.js";

interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}

function writeSession(
  sessionsRoot: string,
  name: string,
  input: {
    id: string;
    parentId: string | null;
    cwd: string;
    timestamp: string;
    events: Array<
      | { timestamp: string; taskStarted: string }
      | { timestamp: string; usage: TokenUsage }
    >;
  },
): void {
  const dayDir = path.join(sessionsRoot, "2026", "08", "11");
  fs.mkdirSync(dayDir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [{
    type: "session_meta",
    timestamp: input.timestamp,
    payload: {
      id: input.id,
      parent_thread_id: input.parentId,
      cwd: input.cwd,
    },
  }];
  for (const event of input.events) {
    rows.push("usage" in event
      ? {
          type: "event_msg",
          timestamp: event.timestamp,
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: event.usage.input,
                cached_input_tokens: event.usage.cached,
                output_tokens: event.usage.output,
                reasoning_output_tokens: 0,
                total_tokens: event.usage.input + event.usage.output,
              },
              // This is only the latest turn delta and must never be summed.
              last_token_usage: {
                input_tokens: 999_999,
                cached_input_tokens: 999_000,
                output_tokens: 999,
                total_tokens: 1_000_998,
              },
            },
          },
        }
      : {
          type: "event_msg",
          timestamp: event.timestamp,
          payload: { type: "task_started", turn_id: event.taskStarted },
        });
  }
  fs.writeFileSync(
    path.join(dayDir, `${name}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

test("recovers complete Codex usage from cumulative deltas across the scan thread tree", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-session-usage-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  fs.mkdirSync(scanDir);

  try {
    writeSession(sessionsRoot, "old-root", {
      id: "old-root",
      parentId: null,
      cwd: scanDir,
      timestamp: "2026-08-11T10:00:00.000Z",
      events: [{
        timestamp: "2026-08-11T10:01:00.000Z",
        usage: { input: 99_000, cached: 90_000, output: 9_000 },
      }],
    });
    writeSession(sessionsRoot, "root", {
      id: "root",
      parentId: null,
      cwd: scanDir,
      timestamp: "2026-08-11T12:00:00.000Z",
      events: [
        { timestamp: "2026-08-11T12:01:00.000Z", usage: { input: 100, cached: 80, output: 10 } },
        { timestamp: "2026-08-11T12:02:00.000Z", usage: { input: 180, cached: 120, output: 20 } },
      ],
    });
    writeSession(sessionsRoot, "worker", {
      id: "worker",
      parentId: "root",
      cwd: scanDir,
      timestamp: "2026-08-11T12:00:30.000Z",
      events: [
        { timestamp: "2026-08-11T12:00:31.000Z", usage: { input: 1_000, cached: 900, output: 50 } },
        { timestamp: "2026-08-11T12:00:32.000Z", taskStarted: "turn-worker" },
        { timestamp: "2026-08-11T12:01:30.000Z", usage: { input: 1_100, cached: 970, output: 60 } },
        { timestamp: "2026-08-11T12:02:30.000Z", usage: { input: 20, cached: 10, output: 5 } },
      ],
    });
    writeSession(sessionsRoot, "grandchild", {
      id: "grandchild",
      parentId: "worker",
      cwd: scanDir,
      timestamp: "2026-08-11T12:00:40.000Z",
      events: [
        { timestamp: "2026-08-11T12:00:41.000Z", taskStarted: "turn-grandchild" },
        { timestamp: "2026-08-11T12:02:45.000Z", usage: { input: 50, cached: 40, output: 5 } },
      ],
    });

    assert.deepEqual(
      recoverCodexSessionUsage(
        scanDir,
        sessionsRoot,
        "2026-08-11T12:00:00.000Z",
        "2026-08-11T12:03:00.000Z",
        "gpt-5.3-codex-spark",
      ),
      {
        estimatedUsd: 0,
        inputTokens: 350,
        cachedInputTokens: 240,
        cacheWriteInputTokens: 0,
        outputTokens: 40,
        model: "gpt-5.3-codex-spark",
      },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails closed when the scan root is ambiguous", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-session-usage-closed-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  fs.mkdirSync(scanDir);

  try {
    for (const id of ["root-a", "root-b"]) {
      writeSession(sessionsRoot, id, {
        id,
        parentId: null,
        cwd: scanDir,
        timestamp: "2026-08-11T12:00:00.000Z",
        events: [{
          timestamp: "2026-08-11T12:01:00.000Z",
          usage: { input: 10, cached: 0, output: 1 },
        }],
      });
    }
    assert.equal(
      recoverCodexSessionUsage(
        scanDir,
        sessionsRoot,
        "2026-08-11T12:00:00.000Z",
        "2026-08-11T12:03:00.000Z",
        "gpt-5.3-codex-spark",
      ),
      null,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
