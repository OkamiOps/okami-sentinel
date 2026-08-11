import assert from "node:assert/strict";
import test from "node:test";
import type { ScanConnectionSelection, ScanRun } from "@csb/shared";
import type { TranslationKey } from "../i18n";
import {
  executionProfileLabel,
  hasExecutionProfileMismatch,
  parsePortableRetryIntent,
  portableRetryHref,
  selectionMatchesPortableRetry,
} from "./execution-profile";

const t = (key: TranslationKey) => key === "newScan.profile.native" ? "Native" : "Portable";

function scan(profile: ScanRun["execution"]): Pick<ScanRun, "execution"> {
  return { execution: profile };
}

const native: NonNullable<ScanRun["execution"]> = {
  executionProfile: "native",
  profileVersion: "openai-codex-security-native-v1",
  methodologyRef: "@openai/codex-security",
  capabilityCheckId: null,
  connectionId: null,
  routeKind: null,
  protocol: null,
  authKind: null,
};

const portable: NonNullable<ScanRun["execution"]> = {
  ...native,
  executionProfile: "portable",
  profileVersion: "sentinel-portable-v1",
  methodologyRef: "sentinel/portable-agent-session/v1",
};

test("labels only persisted execution provenance and detects distinct profiles", () => {
  assert.equal(executionProfileLabel(scan(native), t), "Native");
  assert.equal(executionProfileLabel(scan(portable), t), "Portable");
  assert.equal(executionProfileLabel(scan(null), t), null);
  assert.equal(hasExecutionProfileMismatch([scan(native), scan(portable)]), true);
  assert.equal(hasExecutionProfileMismatch([scan(native), scan(null)]), false);
});

type RetryScan = Pick<
  ScanRun,
  "id" | "repositoryPath" | "engine" | "mode" | "execution" | "launchSelection"
>;

function retryScan(overrides: Partial<RetryScan> = {}): RetryScan {
  return {
    id: "scan-portable-1",
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    mode: "deep",
    execution: {
      ...portable,
      connectionId: "connection-1",
    },
    launchSelection: {
      modelSelectionMode: "catalog",
      modelId: "gpt-5.6-sol",
      paths: ["src", "packages/api"],
    },
    ...overrides,
  };
}

test("builds a faithful Portable retry URL only from persisted launch provenance", () => {
  const href = portableRetryHref(retryScan());
  assert.ok(href);
  const url = new URL(href, "http://sentinel.local");

  assert.equal(url.pathname, "/scans/new");
  assert.equal(url.searchParams.get("from"), "scan-portable-1");
  assert.equal(url.searchParams.get("repositoryPath"), "/workspace/repository");
  assert.equal(url.searchParams.get("engine"), "codex-security");
  assert.equal(url.searchParams.get("connectionId"), "connection-1");
  assert.equal(url.searchParams.get("modelSelectionMode"), "catalog");
  assert.equal(url.searchParams.get("modelId"), "gpt-5.6-sol");
  assert.equal(url.searchParams.get("mode"), "deep");
  assert.equal(url.searchParams.get("paths"), "src,packages/api");
  assert.equal(url.searchParams.has("executionProfilePreference"), false);
  assert.equal(url.searchParams.has("effort"), false);

  assert.deepEqual(parsePortableRetryIntent(url.searchParams), {
    from: "scan-portable-1",
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    connectionId: "connection-1",
    modelSelectionMode: "catalog",
    modelId: "gpt-5.6-sol",
    mode: "deep",
    paths: ["src", "packages/api"],
  });
});

test("round-trips a runtime-default Portable retry without inventing a model or scope", () => {
  const href = portableRetryHref(retryScan({
    mode: "standard",
    launchSelection: {
      modelSelectionMode: "runtime-default",
      modelId: null,
      paths: [],
    },
  }));
  assert.ok(href);
  const params = new URL(href, "http://sentinel.local").searchParams;

  assert.equal(params.has("modelId"), true);
  assert.equal(params.get("modelId"), "");
  assert.equal(params.has("paths"), true);
  assert.equal(params.get("paths"), "");
  assert.deepEqual(parsePortableRetryIntent(params), {
    from: "scan-portable-1",
    repositoryPath: "/workspace/repository",
    engine: "codex-security",
    connectionId: "connection-1",
    modelSelectionMode: "runtime-default",
    modelId: null,
    mode: "standard",
    paths: [],
  });
});

test("hides retry for Native, legacy, or incomplete scan records", () => {
  const incomplete: RetryScan[] = [
    retryScan({ execution: native }),
    retryScan({ execution: null }),
    retryScan({ execution: { ...portable, connectionId: null } }),
    retryScan({ repositoryPath: null }),
    retryScan({ engine: "mantis" }),
    retryScan({ mode: null }),
    retryScan({ launchSelection: null }),
    retryScan({ launchSelection: { modelSelectionMode: "legacy-unknown", modelId: null, paths: [] } }),
    retryScan({ launchSelection: { modelSelectionMode: "catalog", modelId: null, paths: [] } }),
    retryScan({ launchSelection: { modelSelectionMode: "runtime-default", modelId: "invented", paths: [] } }),
  ];

  for (const candidate of incomplete) assert.equal(portableRetryHref(candidate), null);
});

test("rejects incomplete retry query state and never trusts a browser profile preference", () => {
  const href = portableRetryHref(retryScan());
  assert.ok(href);
  const complete = new URL(href, "http://sentinel.local").searchParams;
  complete.set("executionProfilePreference", "portable");
  assert.equal(parsePortableRetryIntent(complete)?.modelId, "gpt-5.6-sol");

  for (const key of [
    "from",
    "repositoryPath",
    "engine",
    "connectionId",
    "modelSelectionMode",
    "modelId",
    "mode",
    "paths",
  ]) {
    const missing = new URLSearchParams(complete);
    missing.delete(key);
    assert.equal(parsePortableRetryIntent(missing), null, `expected ${key} to be required`);
  }
});

test("keeps a retry blocked until the live connection resolves the exact persisted model selection", () => {
  const intent = parsePortableRetryIntent(
    new URL(portableRetryHref(retryScan())!, "http://sentinel.local").searchParams,
  )!;
  const exact: ScanConnectionSelection = {
    connectionId: "connection-1",
    modelSelectionMode: "catalog",
    modelId: "gpt-5.6-sol",
  };

  assert.equal(selectionMatchesPortableRetry(intent, exact), true);
  assert.equal(selectionMatchesPortableRetry(intent, null), false);
  assert.equal(selectionMatchesPortableRetry(intent, { ...exact, modelId: "catalog-fallback" }), false);
  assert.equal(selectionMatchesPortableRetry(intent, {
    connectionId: "connection-1",
    modelSelectionMode: "runtime-default",
    modelId: null,
  }), false);
});
