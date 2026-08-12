import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";

import type { GuardrailRepository } from "@csb/shared";
import tar from "tar-stream";

import {
  SnapshotMaterializationError,
  SnapshotMaterializer,
  extractGitHubArchive,
  type MaterializationLeaseStore,
  type SnapshotArchiveEntry,
} from "./snapshot-materializer.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

test("canonical snapshot identity is stable across archive order and root labels", async () => {
  const root = temporaryRoot();
  try {
    const entries: SnapshotArchiveEntry[] = [
      { name: "src/index.ts", type: "file", content: "export const ok = true;\n", mode: 0o100644 },
      { name: "bin/run", type: "file", content: "#!/bin/sh\nexit 0\n", mode: 0o100755 },
      { name: "src", type: "directory", mode: 0o040755 },
    ];
    const first = await extractGitHubArchive(
      Readable.from([await archive("owner-repo-a", entries)]),
      path.join(root, "first"),
      tinyLimits(),
    );
    const second = await extractGitHubArchive(
      Readable.from([await archive("another-root", [...entries].reverse())]),
      path.join(root, "second"),
      tinyLimits(),
    );

    assert.equal(first.identity, second.identity);
    assert.deepEqual(first.entries, second.entries);
    assert.equal(fs.statSync(path.join(root, "first", "src", "index.ts")).mode & 0o777, 0o400);
    assert.equal(fs.statSync(path.join(root, "first", "bin", "run")).mode & 0o777, 0o500);
  } finally {
    removeTemporaryRoot(root);
  }
});

test("rejects traversal, absolute paths, escaping symlinks, hardlinks and path collisions", async () => {
  const invalidArchives: SnapshotArchiveEntry[][] = [
    [{ name: "../escape", type: "file", content: "x" }],
    [{ name: "/absolute", type: "file", content: "x" }],
    [{ name: "link", type: "symlink", linkname: "../../outside" }],
    [{ name: "hard", type: "link", linkname: "target" }],
    [
      { name: "node", type: "file", content: "x" },
      { name: "node/child", type: "file", content: "x" },
    ],
    [
      { name: "duplicate", type: "file", content: "x" },
      { name: "duplicate", type: "file", content: "y" },
    ],
  ];

  for (const [index, entries] of invalidArchives.entries()) {
    const root = temporaryRoot();
    try {
      await assert.rejects(
        extractGitHubArchive(
          Readable.from([await archive("owner-repo", entries)]),
          path.join(root, `invalid-${index}`),
          tinyLimits(),
        ),
        (error: unknown) => error instanceof SnapshotMaterializationError
          && error.code === "snapshot_archive_invalid",
      );
    } finally {
      removeTemporaryRoot(root);
    }
  }
});

test("enforces entry, per-file and extracted byte limits", async () => {
  const cases: Array<{ entries: SnapshotArchiveEntry[]; limits: ReturnType<typeof tinyLimits> }> = [
    {
      entries: [
        { name: "one", type: "file", content: "1" },
        { name: "two", type: "file", content: "2" },
      ],
      limits: { ...tinyLimits(), maxEntries: 1 },
    },
    {
      entries: [{ name: "large", type: "file", content: "12345" }],
      limits: { ...tinyLimits(), maxFileBytes: 4 },
    },
    {
      entries: [
        { name: "one", type: "file", content: "123" },
        { name: "two", type: "file", content: "456" },
      ],
      limits: { ...tinyLimits(), maxExtractedBytes: 5 },
    },
  ];

  for (const [index, value] of cases.entries()) {
    const root = temporaryRoot();
    try {
      await assert.rejects(
        extractGitHubArchive(
          Readable.from([await archive("owner-repo", value.entries)]),
          path.join(root, `limit-${index}`),
          value.limits,
        ),
        (error: unknown) => error instanceof SnapshotMaterializationError
          && error.code === "snapshot_limit_exceeded",
      );
    } finally {
      removeTemporaryRoot(root);
    }
  }
});

test("reports declared submodules and LFS pointers in snapshot coverage", async () => {
  const root = temporaryRoot();
  try {
    const snapshot = await extractGitHubArchive(
      Readable.from([await archive("owner-repo", [
        {
          name: ".gitmodules",
          type: "file",
          content: '[submodule "vendor/sdk"]\n\tpath = vendor/sdk\n\turl = https://github.com/example/sdk.git\n',
        },
        {
          name: "assets/model.bin",
          type: "file",
          content: `version https://git-lfs.github.com/spec/v1\noid sha256:${"c".repeat(64)}\nsize 12345\n`,
        },
      ])]),
      path.join(root, "snapshot"),
      tinyLimits(),
    );
    assert.deepEqual(snapshot.submodules, ["vendor/sdk"]);
    assert.deepEqual(snapshot.lfsPointers, ["assets/model.bin"]);
  } finally {
    removeTemporaryRoot(root);
  }
});

test("extracts a bounded PAX long path without weakening path validation", async () => {
  const root = temporaryRoot();
  const longPath = `src/${"bounded-".repeat(20)}file.ts`;
  try {
    const snapshot = await extractGitHubArchive(
      Readable.from([await archive("owner-repo", [
        { name: longPath, type: "file", content: "export const safe = true;\n" },
      ])]),
      path.join(root, "snapshot"),
      tinyLimits(),
    );
    assert.equal(snapshot.entries.some((entry) => entry.path === longPath), true);
  } finally {
    removeTemporaryRoot(root);
  }
});

test("materializes exact base and head SHAs under one lease and releases every private path", async () => {
  const root = temporaryRoot();
  const leases: Array<Parameters<MaterializationLeaseStore["save"]>[0]> = [];
  const downloads: string[] = [];
  const store: MaterializationLeaseStore = { save: (lease) => leases.push(structuredClone(lease)) };
  const materializer = new SnapshotMaterializer({
    root,
    leases: store,
    downloadArchive: async (_repository, sha) => {
      downloads.push(sha);
      return Readable.from([await archive("owner-repo", [{ name: "src/app.ts", type: "file", content: sha }])]);
    },
    createLeaseId: () => "lease-1",
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    limits: tinyLimits(),
  });

  try {
    const handle = await materializer.materialize({
      gateId: "gate-1",
      repository: repository(),
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
    assert.deepEqual(downloads, [BASE_SHA, HEAD_SHA]);
    assert.equal(fs.existsSync(handle.base.path), true);
    assert.equal(fs.existsSync(handle.head.path), true);
    assert.notEqual(handle.base.identity, handle.head.identity);
    assert.equal(leases.at(-1)?.state, "ready");
    assert.equal(JSON.stringify(leases).includes(root), false);

    await handle.release();
    assert.equal(fs.existsSync(path.join(root, "gate-1--lease-1")), false);
    assert.equal(leases.at(-1)?.state, "released");
  } finally {
    removeTemporaryRoot(root);
  }
});

test("cancellation removes the in-flight lease root and remains a closed error", async () => {
  const root = temporaryRoot();
  const leases: Array<Parameters<MaterializationLeaseStore["save"]>[0]> = [];
  const controller = new AbortController();
  controller.abort();
  const materializer = new SnapshotMaterializer({
    root,
    leases: { save: (lease) => leases.push(structuredClone(lease)) },
    downloadArchive: async () => Readable.from([await archive("owner-repo", [
      { name: "src/app.ts", type: "file", content: "source" },
    ])]),
    createLeaseId: () => "lease-cancelled",
    limits: tinyLimits(),
  });
  try {
    await assert.rejects(
      materializer.materialize({
        gateId: "gate-cancelled",
        repository: repository(),
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof SnapshotMaterializationError
        && error.code === "snapshot_cancelled",
    );
    assert.equal(fs.existsSync(path.join(root, "gate-cancelled--lease-cancelled")), false);
    assert.equal(leases.at(-1)?.state, "failed");
    assert.notEqual(leases.at(-1)?.releasedAt, null);
  } finally {
    removeTemporaryRoot(root);
  }
});

async function archive(
  root: string,
  entries: SnapshotArchiveEntry[],
): Promise<Buffer> {
  const pack = tar.pack();
  for (const entry of entries) {
    const name = `${root}/${entry.name}`;
    const content = Buffer.from(entry.content ?? "");
    pack.entry({
      name,
      type: entry.type ?? "file",
      mode: entry.mode ?? (entry.type === "directory" ? 0o040755 : 0o100644),
      linkname: entry.linkname,
      size: entry.type === "file" || entry.type === undefined ? content.byteLength : 0,
    }, content);
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

function tinyLimits() {
  return {
    maxEntries: 20,
    maxExtractedBytes: 4_096,
    maxFileBytes: 2_048,
    maxPathBytes: 512,
  };
}

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csb-materializer-test-"));
}

function removeTemporaryRoot(root: string): void {
  if (!fs.existsSync(root)) return;
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function makeWritable(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeWritable(path.join(root, entry.name));
    }
  }
}

function repository(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
}
