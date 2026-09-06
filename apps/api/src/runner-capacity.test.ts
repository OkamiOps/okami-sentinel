const sharedDataDir = process.env.CSB_DATA_DIR ?? "/tmp/csb-api-tests";
const sharedStateDir = process.env.CODEX_SECURITY_STATE_DIR ?? "/tmp/csb-api-state";
process.env.CSB_DATA_DIR = `${sharedDataDir}/runner-capacity-${process.pid}`;
process.env.CODEX_SECURITY_STATE_DIR = `${sharedStateDir}/runner-capacity-${process.pid}`;
process.env.CSB_MAX_CONCURRENT_SCANS = "1";
export {};

const [
  assertModule,
  fsModule,
  osModule,
  pathModule,
  testModule,
  runnerModule,
] = await Promise.all([
  import("node:assert/strict"),
  import("node:fs"),
  import("node:os"),
  import("node:path"),
  import("node:test"),
  import("./runner.js"),
]);

const assert: typeof assertModule.default = assertModule.default;
const fs = fsModule.default;
const os = osModule.default;
const path = pathModule.default;
const test = testModule.default;
const { startScan } = runnerModule;

test("startScan reserves capacity before a pending preflight and releases it when preflight fails", async () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "runner-capacity-"));
  const request = { repositoryPath, engine: "mantis" as const };
  let validateCalls = 0;
  let preflightStarted!: () => void;
  let rejectPreflight!: (reason: Error) => void;
  const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
  const pendingPreflight = new Promise<never>((_resolve, reject) => { rejectPreflight = reject; });

  try {
    const first = startScan(request, {
      dependencies: {
        validateScannerRequest: async () => {
          validateCalls += 1;
          preflightStarted();
          return pendingPreflight;
        },
      },
    });
    await started;

    await assert.rejects(
      startScan(request, {
        dependencies: {
          validateScannerRequest: async () => {
            validateCalls += 1;
            throw new Error("the second preflight must never run");
          },
        },
      }),
      /Limite de scans simultâneos atingido/,
    );
    assert.equal(validateCalls, 1);

    rejectPreflight(new Error("fixture preflight failed"));
    await assert.rejects(first, /fixture preflight failed/);

    await assert.rejects(
      startScan(request, {
        dependencies: {
          validateScannerRequest: async () => {
            validateCalls += 1;
            throw new Error("accepted preflight failed");
          },
        },
      }),
      /accepted preflight failed/,
    );
    assert.equal(validateCalls, 2);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});
