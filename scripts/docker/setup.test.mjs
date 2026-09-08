import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArguments, setupDockerEnvironment } from "./setup.mjs";

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csb-docker-setup-"));
}

test("setup writes secret values outside the checkout and keeps them out of .env.local", (t) => {
  const root = tempDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  const secrets = path.join(root, "operator-secrets");
  fs.mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Docker setup test"], { cwd: checkout });
  fs.writeFileSync(path.join(checkout, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: checkout });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: checkout });

  const result = setupDockerEnvironment({
    checkoutPath: checkout,
    repositoryPath: checkout,
    configDir: secrets,
  });

  const password = fs.readFileSync(result.passwordPath, "utf8").trim();
  const vaultKey = fs.readFileSync(result.vaultKeyPath, "utf8").trim();
  const env = fs.readFileSync(result.envPath, "utf8");
  assert.match(password, /^[A-Za-z0-9_-]{43}$/);
  assert.match(vaultKey, /^[0-9a-f]{64}$/);
  assert.ok(!env.includes(password));
  assert.ok(!env.includes(vaultKey));
  assert.match(env, /CSB_PUBLIC_ORIGIN="http:\/\/127\.0\.0\.1:8787"/);
  assert.match(env, /CSB_LOCAL_PORT="8787"/);
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.passwordPath).mode & 0o777, 0o444);
  assert.equal(fs.statSync(result.vaultKeyPath).mode & 0o777, 0o444);

  const again = setupDockerEnvironment({
    checkoutPath: checkout,
    repositoryPath: checkout,
    configDir: secrets,
  });
  assert.deepEqual(again.created, { env: false, password: false, vaultKey: false });
  assert.equal(fs.readFileSync(result.passwordPath, "utf8").trim(), password);
});

test("setup rejects a secret directory inside the checkout or authorized repository and invalid local origins", (t) => {
  const root = tempDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  const repository = path.join(root, "authorized-repository");
  fs.mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Docker setup test"], { cwd: checkout });
  fs.writeFileSync(path.join(checkout, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: checkout });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: checkout });
  fs.mkdirSync(repository);

  assert.throws(() => setupDockerEnvironment({
    checkoutPath: checkout,
    configDir: path.join(checkout, "secrets"),
  }), /outside the Git checkout/);
  assert.throws(() => setupDockerEnvironment({
    checkoutPath: checkout,
    configDir: path.join(root, "secrets"),
    origin: "http://sentinel.example.test",
  }), /HTTP origin is allowed only/);
  assert.throws(() => setupDockerEnvironment({
    checkoutPath: checkout,
    repositoryPath: repository,
    configDir: path.join(repository, "secrets"),
  }), /outside the authorized repository/);
  assert.throws(() => setupDockerEnvironment({
    checkoutPath: checkout,
    configDir: path.join(root, "secrets"),
    origin: "http://[::1]:8787",
  }), /does not support IPv6 loopback/);
});

test("argument parsing accepts documented options", () => {
  assert.deepEqual(parseArguments([
    "--repository", "/repos/project",
    "--config-dir", "/operator/secrets",
    "--origin", "https://sentinel.example.test",
  ]), {
    repositoryPath: "/repos/project",
    configDir: "/operator/secrets",
    origin: "https://sentinel.example.test",
    help: false,
  });
});
