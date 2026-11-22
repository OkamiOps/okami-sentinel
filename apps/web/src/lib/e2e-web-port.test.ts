import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { e2ePreviewServer, e2eWebOrigin, e2eWebPort } from "./e2e-web-port";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("local runs stay on port 4175 when no e2e port is configured", () => {
  const server = e2ePreviewServer({});
  assert.equal(e2eWebPort({}), 4175);
  assert.equal(e2eWebOrigin({}), "http://127.0.0.1:4175");
  assert.equal(server.baseURL, "http://127.0.0.1:4175");
  assert.equal(server.url, server.baseURL);
  assert.equal(server.reuseExistingServer, false);
  assert.match(server.command, /vite preview --host 127\.0\.0\.1 --port 4175 --strictPort$/);
});

test("CSB_WEB_E2E_PORT selects the preview port and an empty value falls back", () => {
  const server = e2ePreviewServer({ CSB_WEB_E2E_PORT: "4310", CSB_E2E_WEB_PORT: "4999" });
  assert.equal(server.baseURL, "http://127.0.0.1:4310");
  assert.match(server.command, /--port 4310 --strictPort$/);
  assert.equal(e2eWebPort({ CSB_WEB_E2E_PORT: "", CSB_E2E_WEB_PORT: "4311" }), 4311);
  assert.equal(e2eWebPort({ CSB_WEB_E2E_PORT: "", CSB_E2E_WEB_PORT: "" }), 4175);
});

test("rejects a port the preview cannot bind", () => {
  for (const value of ["0", "65536", "4175.5", "nope", "-1"]) {
    assert.throws(() => e2eWebPort({ CSB_WEB_E2E_PORT: value }), /CSB_WEB_E2E_PORT must be a valid local port/);
  }
  assert.throws(() => e2eWebPort({ CSB_E2E_WEB_PORT: "0" }), /CSB_E2E_WEB_PORT must be a valid local port/);
});

test("playwright config webServer follows the same port, including the default", () => {
  assert.deepEqual(loadedPreview({ CSB_WEB_E2E_PORT: "4321" }), e2ePreviewServer({ CSB_WEB_E2E_PORT: "4321" }));
  assert.deepEqual(loadedPreview({}), e2ePreviewServer({}));
});

function loadedPreview(overrides: NodeJS.ProcessEnv): ReturnType<typeof e2ePreviewServer> {
  const env = { ...process.env };
  delete env.CSB_WEB_E2E_PORT;
  delete env.CSB_E2E_WEB_PORT;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const config = (await import("./playwright.config.ts")).default;
    const webServer = config.webServer;
    if (Array.isArray(webServer)) throw new Error("mocked config must use one webServer");
    console.log(JSON.stringify({
      command: webServer.command,
      url: webServer.url,
      baseURL: config.use.baseURL,
      reuseExistingServer: webServer.reuseExistingServer,
    }));
  `], { cwd: webRoot, env, encoding: "utf8" });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const line = child.stdout.trim().split("\n").at(-1);
  assert.ok(line, child.stdout);
  return JSON.parse(line) as ReturnType<typeof e2ePreviewServer>;
}
