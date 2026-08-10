import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createWorkspaceToolHost } from "./workspace-tool-host.js";

test("workspace tools reject traversal and symlink escape while artifacts stay in the run root", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-host-"));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  const outsideFile = join(root, "outside.txt");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot);
  await writeFile(outsideFile, "outside");
  await symlink(outsideFile, join(snapshotRoot, "escape-link.txt"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });

  await assert.rejects(host.call("workspace.read", { path: "../outside.txt" }), {
    code: "tool_path_denied",
  });
  await assert.rejects(host.call("workspace.read", { path: "escape-link.txt" }), {
    code: "tool_path_denied",
  });

  const result = await host.call("results.write", { path: "report.json", content: "{}" });
  assert.deepEqual(result.artifact, { path: "report.json", bytes: 2 });
  assert.equal(await fileExists(join(artifactRoot, "report.json")), true);
  assert.equal(await fileExists(join(snapshotRoot, "report.json")), false);
});

test("workspace listing defaults to the snapshot root and exposes no extra tool capability", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-host-list-"));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot);
  await writeFile(join(snapshotRoot, "visible.txt"), "visible");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });
  const listing = await host.call("workspace.list", {});
  assert.equal(listing.content.includes("visible.txt"), true);
  await assert.rejects(host.call("workspace.execute" as never, {}), { code: "tool_name_denied" });
  await assert.rejects(host.call("results.write", { path: "../outside.json", content: "{}" }), {
    code: "tool_path_denied",
  });
});

test("each read-only tool applies its remaining output budget before filesystem work", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-host-budget-"));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot);
  await writeFile(join(snapshotRoot, "visible.txt"), "visible needle");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });
  const budget = { maxOutputBytes: 1 };
  const outcomes = await Promise.allSettled([
    host.call("workspace.read", { path: "visible.txt" }, budget),
    host.call("workspace.search", { query: "needle" }, budget),
    host.call("workspace.list", {}, budget),
  ]);

  assert.deepEqual(outcomes.map(errorCode), [
    "agent_output_byte_limit",
    "agent_output_byte_limit",
    "agent_output_byte_limit",
  ]);
});

test("results.write rejects an insufficient output budget before creating a file", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-host-write-budget-"));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });
  await assert.rejects(
    host.call("results.write", { path: "must-not-exist.json", content: "{}" }, { maxOutputBytes: 1 }),
    { code: "agent_output_byte_limit" },
  );
  assert.equal(await fileExists(join(artifactRoot, "must-not-exist.json")), false);
});

test("a snapshot-root inode swap after host creation is rejected", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-host-snapshot-swap-"));
  const snapshotRoot = join(root, "snapshot");
  const originalSnapshot = join(root, "snapshot-original");
  const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot);
  await writeFile(join(snapshotRoot, "visible.txt"), "original");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });
  await rename(snapshotRoot, originalSnapshot);
  await mkdir(snapshotRoot);
  await writeFile(join(snapshotRoot, "visible.txt"), "swapped");

  await assert.rejects(host.call("workspace.read", { path: "visible.txt" }), {
    code: "tool_path_denied",
  });
});

test("an artifact-root inode swap after host creation is rejected before write", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-host-artifact-swap-"));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  const originalArtifacts = join(root, "artifacts-original");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const host = await createWorkspaceToolHost({ snapshotRoot, artifactRoot });
  await rename(artifactRoot, originalArtifacts);
  await mkdir(artifactRoot);

  await assert.rejects(host.call("results.write", { path: "report.json", content: "{}" }), {
    code: "tool_write_denied",
  });
  assert.equal(await fileExists(join(artifactRoot, "report.json")), false);
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorCode(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === "fulfilled") return null;
  const reason: unknown = result.reason;
  return typeof reason === "object" && reason !== null && typeof (reason as { code?: unknown }).code === "string"
    ? (reason as { code: string }).code
    : null;
}
