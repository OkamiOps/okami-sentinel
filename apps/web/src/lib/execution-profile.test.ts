import assert from "node:assert/strict";
import test from "node:test";
import type { ScanRun } from "@csb/shared";
import type { TranslationKey } from "../i18n";
import { executionProfileLabel, hasExecutionProfileMismatch } from "./execution-profile";

const t = (key: TranslationKey) => key === "newScan.profile.native" ? "Native" : "Portable";

function scan(profile: ScanRun["execution"]): Pick<ScanRun, "execution"> {
  return { execution: profile };
}

const native: ScanRun["execution"] = {
  executionProfile: "native",
  profileVersion: "openai-codex-security-native-v1",
  methodologyRef: "@openai/codex-security",
  capabilityCheckId: null,
  connectionId: null,
  routeKind: null,
  protocol: null,
  authKind: null,
};

const portable: ScanRun["execution"] = {
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
