import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeVulnHunterHttpBundle,
  VULNHUNTER_HTTP_BUNDLE_NAME,
  VulnHunterHttpBundleError,
} from "./vulnhunter-http-bundle.js";

const MARKDOWN_ARTIFACTS = [
  "reconnaissance.md",
  "trace-review.md",
  "verification.md",
  "validation-notes.md",
  "coverage-sweep.md",
  "README.md",
] as const;

interface BundleFixtureArtifact {
  name: string;
  content: unknown;
}

interface BundleFixture {
  schemaVersion: number;
  artifacts: BundleFixtureArtifact[];
}

function validBundle(): BundleFixture {
  return {
    schemaVersion: 1,
    artifacts: [
      ...MARKDOWN_ARTIFACTS.map((name) => ({ name, content: `# ${name}\nDefensive static evidence.` })),
      { name: "sentinel-findings.json", content: { schemaVersion: 1, findings: [] } },
    ],
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-vulnhunter-http-bundle-"));
  const handoffRoot = path.join(root, "handoff");
  const resultsDir = path.join(root, "results");
  fs.mkdirSync(handoffRoot, { mode: 0o700 });
  fs.mkdirSync(resultsDir, { mode: 0o700 });
  return { root, handoffRoot, resultsDir };
}

function writeBundle(handoffRoot: string, value: unknown): void {
  fs.writeFileSync(
    path.join(handoffRoot, VULNHUNTER_HTTP_BUNDLE_NAME),
    typeof value === "string" ? value : JSON.stringify(value),
    { encoding: "utf8", mode: 0o600 },
  );
}

test("VulnHunter HTTP materializes exactly the defensive legacy artifacts from one bundle", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    writeBundle(handoffRoot, validBundle());

    materializeVulnHunterHttpBundle(handoffRoot, resultsDir);

    assert.deepEqual(fs.readdirSync(resultsDir).sort(), [
      ...MARKDOWN_ARTIFACTS,
      "sentinel-findings.json",
    ].sort());
    for (const name of [...MARKDOWN_ARTIFACTS, "sentinel-findings.json"]) {
      assert.equal(fs.statSync(path.join(resultsDir, name)).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(resultsDir, "sentinel-findings.json"), "utf8")),
      { schemaVersion: 1, findings: [] },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP derives the nested handoff version from the validated outer bundle", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    const bundle = validBundle();
    bundle.artifacts[bundle.artifacts.length - 1] = {
      name: "sentinel-findings.json",
      content: { findings: [] },
    };
    writeBundle(handoffRoot, bundle);

    materializeVulnHunterHttpBundle(handoffRoot, resultsDir);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(resultsDir, "sentinel-findings.json"), "utf8")),
      { schemaVersion: 1, findings: [] },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VulnHunter HTTP rejects malformed, missing, extra, or duplicate bundle artifacts before materialization", () => {
  const cases: Array<[string, unknown, (handoffRoot: string) => void]> = [
    ["malformed", "{not-json", () => undefined],
    ["missing", { schemaVersion: 1, artifacts: validBundle().artifacts?.slice(0, -1) }, () => undefined],
    ["extra", {
      schemaVersion: 1,
      artifacts: [...(validBundle().artifacts as unknown[]), { name: "extra.md", content: "no" }],
    }, () => undefined],
    ["duplicate", {
      schemaVersion: 1,
      artifacts: [
        ...(validBundle().artifacts as unknown[]),
        { name: "README.md", content: "duplicate" },
      ],
    }, () => undefined],
    ["unexpected-file", validBundle(), (handoffRoot) => {
      fs.writeFileSync(path.join(handoffRoot, "extra.txt"), "no", { mode: 0o600 });
    }],
  ];

  for (const [name, bundle, afterWrite] of cases) {
    const { root, handoffRoot, resultsDir } = fixture();
    try {
      writeBundle(handoffRoot, bundle);
      afterWrite(handoffRoot);
      assert.throws(
        () => materializeVulnHunterHttpBundle(handoffRoot, resultsDir),
        (error: unknown) => error instanceof VulnHunterHttpBundleError && error.code === "bundle_invalid",
        name,
      );
      assert.deepEqual(fs.readdirSync(resultsDir), [], `${name} must not partially materialize`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("VulnHunter HTTP rejects a sentinel handoff that does not meet schemaVersion 1", () => {
  const { root, handoffRoot, resultsDir } = fixture();
  try {
    const bundle = validBundle();
    const artifacts = bundle.artifacts;
    artifacts[artifacts.length - 1] = {
      name: "sentinel-findings.json",
      content: { schemaVersion: 2, findings: [] },
    };
    writeBundle(handoffRoot, bundle);

    assert.throws(
      () => materializeVulnHunterHttpBundle(handoffRoot, resultsDir),
      (error: unknown) => error instanceof VulnHunterHttpBundleError && error.code === "bundle_invalid",
    );
    assert.deepEqual(fs.readdirSync(resultsDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
