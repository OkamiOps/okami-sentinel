import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MantisSourceError,
  resolveMantisLocalSource,
  type MantisSourceCommand,
} from "./mantis-source.js";

const REF = "a".repeat(40);
const SKILLS = [
  "mantis-architecture",
  "mantis-threat-model",
  "mantis-plan",
  "mantis-researcher",
  "mantis-dedupe",
  "mantis-review",
  "mantis-critic",
  "mantis-calibrate",
  "mantis-report",
];

function populateSkills(root: string): void {
  for (const skill of SKILLS) {
    const directory = path.join(root, skill);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `# ${skill}\n`, { mode: 0o600 });
  }
}

test("Mantis local source clones argv-only, verifies the exact revision, and returns a private pinned skills root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-"));
  const calls: Array<{ command: string; args: string[]; shell: false }> = [];
  const command: MantisSourceCommand = async (binary, args, options) => {
    calls.push({ command: binary, args: [...args], shell: options.shell });
    if (args[0] === "clone") {
      fs.mkdirSync(args.at(-1)!, { recursive: true, mode: 0o700 });
      return { stdout: "", stderr: "" };
    }
    if (args.includes("checkout")) {
      populateSkills(args[1]!);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("rev-parse")) return { stdout: `${REF}\n`, stderr: "" };
    throw new Error(`unexpected git argv: ${args.join(" ")}`);
  };

  try {
    const source = await resolveMantisLocalSource({
      repositoryUrl: "https://example.test/google/mantis.git",
      ref: REF,
      cacheDir: path.join(root, "cache"),
      command,
    });

    assert.match(source.skillsRoot, new RegExp(`${REF.slice(0, 12)}$`));
    assert.equal(fs.statSync(source.skillsRoot).mode & 0o077, 0);
    assert.deepEqual(calls.map((call) => call.command), ["git", "git", "git"]);
    assert.deepEqual(calls.map((call) => call.shell), [false, false, false]);
    assert.deepEqual(calls[0]?.args.slice(0, 4), ["clone", "--filter=blob:none", "--no-checkout", "https://example.test/google/mantis.git"]);
    assert.deepEqual(calls[1]?.args.slice(0, 5), ["-C", source.skillsRoot, "checkout", "--detach", REF]);
    assert.deepEqual(calls[2]?.args, ["-C", source.skillsRoot, "rev-parse", "HEAD"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local source rejects a missing or mismatched exact checkout before a worker can start", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-mismatch-"));
  let calls = 0;
  try {
    await assert.rejects(
      resolveMantisLocalSource({
        repositoryUrl: "https://example.test/google/mantis.git",
        ref: REF,
        cacheDir: path.join(root, "cache"),
        command: async (_binary, args) => {
          calls += 1;
          if (args[0] === "clone") {
            fs.mkdirSync(args.at(-1)!, { recursive: true, mode: 0o700 });
            return { stdout: "", stderr: "" };
          }
          if (args.includes("checkout")) {
            populateSkills(args[1]!);
            return { stdout: "", stderr: "" };
          }
          return { stdout: `${"b".repeat(40)}\n`, stderr: "" };
        },
      }),
      (error: unknown) => error instanceof MantisSourceError && error.code === "source_invalid",
    );
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local source honors an already-aborted request before git preflight", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    resolveMantisLocalSource({
      repositoryUrl: "https://example.test/google/mantis.git",
      ref: REF,
      cacheDir: path.join(os.tmpdir(), "mantis-source-unused"),
      signal: controller.signal,
      command: async () => {
        calls += 1;
        return { stdout: "", stderr: "" };
      },
    }),
    (error: unknown) => error instanceof MantisSourceError && error.code === "source_cancelled",
  );
  assert.equal(calls, 0);
});
