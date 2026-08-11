import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentSession } from "../agent/session-types.js";
import {
  PORTABLE_CODEX_SECURITY_TOOL_SURFACE,
  PortableCodexSecurityStageError,
  addPortableCodexSecurityUsage,
  hashPortableCodexSecuritySnapshot,
  observePortableCodexSecurityStage,
} from "./portable-codex-security-worker-support.js";
import { createPortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";
import { PORTABLE_CODEX_SECURITY_STAGES } from "./portable-codex-security-profile.js";

function stageSession(events: readonly unknown[]): AgentSession {
  return {
    async *run() {
      for (const event of events) yield event as never;
    },
    async cancel() { return { remote: false }; },
  };
}

function readyEvents(artifact: string): unknown[] {
  return [
    { type: "tool", phase: "requested", callId: "read", name: "workspace.read" },
    { type: "tool", phase: "consumed", callId: "read", name: "workspace.read" },
    { type: "tool", phase: "requested", callId: "write", name: "results.write" },
    { type: "tool", phase: "result", callId: "write", name: "results.write" },
    { type: "artifact", path: artifact, bytes: 1 },
    { type: "completion", text: null, structured: { stage: "inventory", artifact, status: "completed", summary: "ok" } },
  ];
}

test("Portable Codex Security exposes exactly four local workspace tools", () => {
  assert.deepEqual(PORTABLE_CODEX_SECURITY_TOOL_SURFACE, [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "results.write",
  ]);
});

test("Portable Codex Security snapshot hashing rejects a symlink instead of following it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-snapshot-hash-"));
  try {
    fs.writeFileSync(path.join(root, "safe.ts"), "export const safe = true;\n");
    fs.symlinkSync(path.join(root, "safe.ts"), path.join(root, "unsafe.ts"));
    assert.throws(
      () => hashPortableCodexSecuritySnapshot(root),
      (error: unknown) => error instanceof PortableCodexSecurityStageError &&
        error.code === "snapshot_invalid",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable Codex Security stage evidence rejects missing, extra, wrong, unknown, or malformed events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-stage-evidence-"));
  const stage = PORTABLE_CODEX_SECURITY_STAGES[0]!;
  try {
    for (const mutate of [
      (events: unknown[]) => events.filter((event) => (event as { type?: string }).type !== "artifact"),
      (events: unknown[]) => [...events, { type: "artifact", path: stage.artifact, bytes: 1 }],
      (events: unknown[]) => events.map((event) => (event as { type?: string }).type === "artifact"
        ? { type: "artifact", path: "wrong.json", bytes: 1 }
        : event),
      (events: unknown[]) => events.map((event) => (event as { type?: string }).type === "tool"
        ? { ...(event as object), name: "shell.exec" }
        : event),
      (events: unknown[]) => events.map((event) => (event as { type?: string }).type === "completion"
        ? { type: "completion", text: null, structured: { stage: "report", artifact: stage.artifact, status: "completed" } }
        : event),
    ]) {
      const artifactRoot = fs.mkdtempSync(path.join(root, "stage-"));
      fs.writeFileSync(path.join(artifactRoot, stage.artifact), JSON.stringify({ schemaVersion: 1, stage: "inventory" }));
      await assert.rejects(
        observePortableCodexSecurityStage({
          session: stageSession(mutate(readyEvents(stage.artifact))),
          stage,
          artifactRoot,
          dossier: createPortableCodexSecurityDossier(),
          usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
          redact: (value) => value,
        }),
        (error: unknown) => error instanceof PortableCodexSecurityStageError,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable Codex Security stage evidence rejects unexpected files outside its one artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-stage-files-"));
  const stage = PORTABLE_CODEX_SECURITY_STAGES[0]!;
  try {
    fs.writeFileSync(path.join(root, stage.artifact), JSON.stringify({ schemaVersion: 1, stage: "inventory" }));
    fs.writeFileSync(path.join(root, "extra.json"), "{}");
    await assert.rejects(
      observePortableCodexSecurityStage({
        session: stageSession(readyEvents(stage.artifact)),
        stage,
        artifactRoot: root,
        dossier: createPortableCodexSecurityDossier(),
        usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        redact: (value) => value,
      }),
      (error: unknown) => error instanceof PortableCodexSecurityStageError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable Codex Security accepts a validated terminal artifact without a provider completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-terminal-artifact-"));
  const stage = PORTABLE_CODEX_SECURITY_STAGES[0]!;
  try {
    fs.writeFileSync(
      path.join(root, stage.artifact),
      JSON.stringify({
        schemaVersion: 1,
        stage: stage.id,
        summary: "Inventory artifact validated",
        observations: [],
      }),
    );
    const observed = await observePortableCodexSecurityStage({
      session: stageSession([
        { type: "tool", phase: "requested", callId: "read", name: "workspace.read" },
        { type: "tool", phase: "consumed", callId: "read", name: "workspace.read" },
        { type: "tool", phase: "requested", callId: "write", name: "results.write" },
        { type: "tool", phase: "result", callId: "write", name: "results.write" },
        { type: "artifact", path: stage.artifact, bytes: 1 },
      ]),
      stage,
      artifactRoot: root,
      dossier: createPortableCodexSecurityDossier(),
      usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      redact: (value) => value,
    });

    assert.deepEqual(
      JSON.parse(Buffer.from(observed.dossierStateBase64, "base64").toString("utf8")),
      {
        ...createPortableCodexSecurityDossier(),
        stageSummaries: [{ stage: "inventory", summary: "Inventory artifact validated" }],
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable Codex Security accepts one corrected write after a rejected artifact attempt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-corrected-artifact-"));
  const stage = PORTABLE_CODEX_SECURITY_STAGES[0]!;
  try {
    fs.writeFileSync(
      path.join(root, stage.artifact),
      JSON.stringify({
        schemaVersion: 1,
        stage: stage.id,
        summary: "Corrected inventory artifact",
        observations: [],
      }),
    );
    const observed = await observePortableCodexSecurityStage({
      session: stageSession([
        { type: "tool", phase: "requested", callId: "read", name: "workspace.read" },
        { type: "tool", phase: "consumed", callId: "read", name: "workspace.read" },
        { type: "tool", phase: "requested", callId: "write-invalid", name: "results.write" },
        {
          type: "tool",
          phase: "result",
          callId: "write-invalid",
          name: "results.write",
          ok: false,
        },
        { type: "tool", phase: "requested", callId: "write-valid", name: "results.write" },
        { type: "tool", phase: "result", callId: "write-valid", name: "results.write" },
        { type: "artifact", path: stage.artifact, bytes: 1 },
      ]),
      stage,
      artifactRoot: root,
      dossier: createPortableCodexSecurityDossier(),
      usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      redact: (value) => value,
    });

    assert.deepEqual(
      JSON.parse(Buffer.from(observed.dossierStateBase64, "base64").toString("utf8")),
      {
        ...createPortableCodexSecurityDossier(),
        stageSummaries: [{ stage: "inventory", summary: "Corrected inventory artifact" }],
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable Codex Security does not count a rejected workspace result as consumed evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-rejected-evidence-"));
  const stage = PORTABLE_CODEX_SECURITY_STAGES[0]!;
  try {
    fs.writeFileSync(
      path.join(root, stage.artifact),
      JSON.stringify({ schemaVersion: 1, stage: "inventory" }),
    );
    const events = readyEvents(stage.artifact).map((event) => {
      const tool = event as { type?: string; phase?: string; name?: string };
      return tool.type === "tool" && tool.phase === "consumed" && tool.name === "workspace.read"
        ? { ...tool, ok: false }
        : event;
    });

    await assert.rejects(
      observePortableCodexSecurityStage({
        session: stageSession(events),
        stage,
        artifactRoot: root,
        dossier: createPortableCodexSecurityDossier(),
        usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        redact: (value) => value,
      }),
      (error: unknown) => error instanceof PortableCodexSecurityStageError &&
        error.code === "stage_evidence_incomplete",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Portable Codex Security preserves a safe session limit failure code", async () => {
  const stage = PORTABLE_CODEX_SECURITY_STAGES[0]!;
  await assert.rejects(
    observePortableCodexSecurityStage({
      session: stageSession([{ type: "failure", code: "agent_input_byte_limit" }]),
      stage,
      artifactRoot: os.tmpdir(),
      dossier: createPortableCodexSecurityDossier(),
      usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      redact: (value) => value,
    }),
    (error: unknown) => error instanceof PortableCodexSecurityStageError &&
      error.code === "agent_input_byte_limit",
  );
});

test("Portable Codex Security usage preserves missing counters and aggregates cache-write only when reported", () => {
  const empty = {
    reported: false,
    inputTokensKnown: false,
    cachedInputTokensKnown: false,
    cacheWriteInputTokensKnown: false,
    outputTokensKnown: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const partial = addPortableCodexSecurityUsage(empty, {
    inputTokens: null,
    cachedInputTokens: 3,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  });
  assert.deepEqual(partial, {
    reported: true,
    inputTokensKnown: false,
    cachedInputTokensKnown: true,
    cacheWriteInputTokensKnown: false,
    outputTokensKnown: false,
    inputTokens: 0,
    cachedInputTokens: 3,
    outputTokens: 0,
  });
  const withCacheWrite = addPortableCodexSecurityUsage(partial, {
    inputTokens: 4,
    cachedInputTokens: null,
    outputTokens: 2,
    reasoningTokens: null,
    cacheWriteInputTokens: 7,
  } as never);
  assert.deepEqual(withCacheWrite, {
    reported: true,
    inputTokensKnown: false,
    cachedInputTokensKnown: false,
    cacheWriteInputTokensKnown: false,
    outputTokensKnown: false,
    maximumInputTokensPerRequest: 4,
    inputTokens: 4,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 7,
    outputTokens: 2,
  });
});
