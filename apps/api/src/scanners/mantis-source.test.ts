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

function populateLargeSkill(root: string): void {
  populateSkills(root);
  fs.writeFileSync(
    path.join(root, "mantis-calibrate", "SKILL.md"),
    `# mantis-calibrate\n${"T".repeat(41_402)}\n`,
    { mode: 0o600 },
  );
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
    assert.equal(source.sourceCacheDir, path.join(root, "cache"));
    assert.equal(fs.statSync(source.skillsRoot).mode & 0o077, 0);
    assert.deepEqual(calls.map((call) => call.command), ["git", "git", "git"]);
    assert.deepEqual(calls.map((call) => call.shell), [false, false, false]);
    assert.deepEqual(calls[0]?.args.slice(0, 4), ["clone", "--filter=blob:none", "--no-checkout", "https://example.test/google/mantis.git"]);
    assert.deepEqual(calls[1]?.args.slice(0, 1), ["-C"]);
    assert.notEqual(calls[1]?.args[1], source.skillsRoot);
    assert.deepEqual(calls[1]?.args.slice(2), ["checkout", "--detach", REF]);
    assert.deepEqual(calls[2]?.args.slice(0, 1), ["-C"]);
    assert.equal(calls[2]?.args[1], calls[1]?.args[1]);
    assert.deepEqual(calls[2]?.args.slice(2), ["rev-parse", "HEAD"]);
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

test("Mantis local source serializes one cold clone per SHA and atomically shares its validated checkout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-concurrent-"));
  const cacheDir = path.join(root, "cache");
  let cloneCalls = 0;
  const command: MantisSourceCommand = async (_binary, args) => {
    if (args[0] === "clone") {
      cloneCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    const [first, second] = await Promise.all([
      resolveMantisLocalSource({
        repositoryUrl: "https://example.test/google/mantis.git",
        ref: REF,
        cacheDir,
        command,
      }),
      resolveMantisLocalSource({
        repositoryUrl: "https://example.test/google/mantis.git",
        ref: REF,
        cacheDir,
        command,
      }),
    ]);

    assert.equal(cloneCalls, 1);
    assert.equal(first.skillsRoot, second.skillsRoot);
    assert.equal(first.skillsRoot, path.join(cacheDir, REF.slice(0, 12)));
    assert.equal(fs.existsSync(first.skillsRoot), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local source never publishes a checkout aborted during its cold clone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-aborted-clone-"));
  const cacheDir = path.join(root, "cache");
  const controller = new AbortController();
  try {
    await assert.rejects(
      resolveMantisLocalSource({
        repositoryUrl: "https://example.test/google/mantis.git",
        ref: REF,
        cacheDir,
        signal: controller.signal,
        command: async (_binary, args) => {
          if (args[0] === "clone") {
            fs.mkdirSync(args.at(-1)!, { recursive: true, mode: 0o700 });
            controller.abort();
            throw new Error("clone interrupted");
          }
          throw new Error("checkout must not run after abort");
        },
      }),
      (error: unknown) => error instanceof MantisSourceError && error.code === "source_cancelled",
    );
    assert.equal(fs.existsSync(path.join(cacheDir, REF.slice(0, 12))), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local source reclaims an abandoned SHA lock instead of waiting forever", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-stale-lock-"));
  const cacheDir = path.join(root, "cache");
  const lockRoot = path.join(cacheDir, `.mantis-source-${REF}.lock`);
  const controller = new AbortController();
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  fs.utimesSync(lockRoot, new Date(0), new Date(0));
  const command: MantisSourceCommand = async (_binary, args) => {
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
    const source = await new Promise<Awaited<ReturnType<typeof resolveMantisLocalSource>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error("stale Mantis cache lock was not reclaimed"));
      }, 100);
      void resolveMantisLocalSource({
        repositoryUrl: "https://example.test/google/mantis.git",
        ref: REF,
        cacheDir,
        signal: controller.signal,
        command,
      }).then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(source.skillsRoot, path.join(cacheDir, REF.slice(0, 12)));
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

test("Mantis local source accepts the reviewed 41,402-byte stage skill before worker launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-large-skill-"));
  try {
    const source = await resolveMantisLocalSource({
      repositoryUrl: "https://example.test/google/mantis.git",
      ref: REF,
      cacheDir: path.join(root, "cache"),
      command: async (_binary, args) => {
        if (args[0] === "clone") {
          fs.mkdirSync(args.at(-1)!, { recursive: true, mode: 0o700 });
          return { stdout: "", stderr: "" };
        }
        if (args.includes("checkout")) {
          populateLargeSkill(args[1]!);
          return { stdout: "", stderr: "" };
        }
        return { stdout: `${REF}\n`, stderr: "" };
      },
    });
    assert.equal(fs.statSync(path.join(source.skillsRoot, "mantis-calibrate", "SKILL.md")).size, 41_422);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mantis local source waits for the native git child close after aborting its exact preflight process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-source-native-abort-"));
  const bin = path.join(root, "bin");
  const marker = path.join(root, "marker");
  const originalPath = process.env.PATH;
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
trap 'printf terminated > ${JSON.stringify(marker)}; exit 143' TERM
printf started > ${JSON.stringify(marker)}
while :; do :; done
`, { mode: 0o700 });
  const controller = new AbortController();
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const operation = resolveMantisLocalSource({
    repositoryUrl: "https://example.test/google/mantis.git",
    ref: REF,
    cacheDir: path.join(root, "cache"),
    signal: controller.signal,
    timeoutMs: 5_000,
  });

  try {
    const started = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 500;
      const poll = () => {
        if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === "started") {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    assert.equal(started, true, "native git test process did not start");
    controller.abort();
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof MantisSourceError && error.code === "source_cancelled",
    );
    assert.equal(fs.readFileSync(marker, "utf8"), "terminated");
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
