import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
