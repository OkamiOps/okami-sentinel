import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ORIGIN = "http://127.0.0.1:8787";

export function parseArguments(argv) {
  const input = {
    repositoryPath: null,
    configDir: null,
    origin: DEFAULT_ORIGIN,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      input.help = true;
      continue;
    }
    if (value === "--repository" || value === "--config-dir" || value === "--origin") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`missing value for ${value}`);
      index += 1;
      if (value === "--repository") input.repositoryPath = next;
      if (value === "--config-dir") input.configDir = next;
      if (value === "--origin") input.origin = next;
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }

  return input;
}

export function setupDockerEnvironment({
  checkoutPath,
  repositoryPath = checkoutPath,
  configDir = path.join(os.homedir(), ".local", "share", "okami-sentinel"),
  origin = DEFAULT_ORIGIN,
}) {
  const checkout = realDirectory(checkoutPath, "checkout");
  const repository = realDirectory(repositoryPath, "authorized repository");
  const targetConfigDir = path.resolve(configDir);
  assertPrivateConfigOutside(targetConfigDir, checkout, repository);
  ensurePrivateDirectory(targetConfigDir);
  assertPrivateConfigOutside(fs.realpathSync(targetConfigDir), checkout, repository);

  const publicOrigin = validatePublicOrigin(origin);
  const localPort = loopbackPort(publicOrigin);
  const workflowSha = releaseSha(checkout);
  const passwordPath = path.join(targetConfigDir, "admin_password");
  const vaultKeyPath = path.join(targetConfigDir, "vault_key");
  const passwordCreated = writeSecretIfMissing(
    passwordPath,
    `${randomBytes(32).toString("base64url")}\n`,
  );
  const vaultKeyCreated = writeSecretIfMissing(
    vaultKeyPath,
    `${randomBytes(32).toString("hex")}\n`,
  );

  const envPath = path.join(checkout, ".env.local");
  const envCreated = writeEnvIfMissing(envPath, {
    CSB_COMPOSE_PROJECT_NAME: "okami-sentinel",
    CSB_GITHUB_ACTIONS_WORKFLOW_SHA: workflowSha,
    CSB_PUBLIC_ORIGIN: publicOrigin,
    ...(localPort === null ? {} : { CSB_LOCAL_PORT: localPort }),
    CSB_ADMIN_USER: "admin",
    CSB_ADMIN_PASSWORD_PATH: passwordPath,
    CSB_VAULT_KEY_PATH: vaultKeyPath,
    CSB_REPOSITORY_PATH: repository,
  });

  return {
    checkout,
    envPath,
    passwordPath,
    vaultKeyPath,
    publicOrigin,
    workflowSha,
    created: {
      env: envCreated,
      password: passwordCreated,
      vaultKey: vaultKeyCreated,
    },
  };
}

function realDirectory(input, label) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${label} path is required`);
  }
  const target = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(target).isDirectory()) throw new Error(`${label} is not a directory: ${target}`);
  return target;
}

function assertPrivateConfigOutside(candidate, checkout, repository) {
  if (candidate === checkout || candidate.startsWith(`${checkout}${path.sep}`)) {
    throw new Error("secret directory must be outside the Git checkout");
  }
  if (candidate === repository || candidate.startsWith(`${repository}${path.sep}`)) {
    throw new Error("secret directory must be outside the authorized repository");
  }
}

function ensurePrivateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`secret directory is not a real directory: ${target}`);
  }
  fs.chmodSync(target, 0o700);
}

function validatePublicOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--origin must be a valid absolute URL");
  }
  if (parsed.origin !== value) {
    throw new Error("--origin must not contain a path, query, fragment, or trailing slash");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol === "http:" && parsed.hostname === "[::1]") {
    throw new Error("--origin does not support IPv6 loopback because compose.local.yaml publishes only 127.0.0.1");
  }
  if (parsed.protocol === "http:" && !local) {
    throw new Error("HTTP origin is allowed only for a loopback installation; use HTTPS for a hosted origin");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--origin must use HTTP or HTTPS");
  }
  return parsed.origin;
}

function loopbackPort(origin) {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    return null;
  }
  return parsed.port || "80";
}

function releaseSha(checkout) {
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("could not resolve a 40-character Git release SHA");
  }
  return value;
}

function writeSecretIfMissing(target, contents) {
  try {
    const descriptor = fs.openSync(target, "wx", 0o444);
    try {
      fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(target, 0o444);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`secret path is not a regular file: ${target}`);
    return false;
  }
}

function writeEnvIfMissing(target, values) {
  if (fs.existsSync(target)) return false;
  const lines = [
    "# Generated by scripts/docker/setup.mjs. It contains paths, not secret values.",
    ...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    "",
  ];
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, lines.join("\n"), { encoding: "utf8" });
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(target, 0o600);
  return true;
}

export function helpText() {
  return [
    "Usage: node scripts/docker/setup.mjs [options]",
    "",
    "Creates an ignored .env.local and secret files outside this checkout.",
    "It never prints generated secret values.",
    "",
    "Options:",
    "  --repository <path>  Read-only repository mounted at /repos/projeto (default: current checkout)",
    "  --config-dir <path>  Secret directory (default: ~/.local/share/okami-sentinel)",
    "  --origin <url>       http://127.0.0.1:8787 or an HTTPS public origin",
  ].join("\n");
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const result = setupDockerEnvironment({
    checkoutPath: process.cwd(),
    repositoryPath: options.repositoryPath ? path.resolve(options.repositoryPath) : process.cwd(),
    configDir: options.configDir ? path.resolve(options.configDir) : undefined,
    origin: options.origin,
  });
  console.log(`Compose environment ${result.created.env ? "created" : "preserved"}: ${result.envPath}`);
  console.log(`Administrative password file ${result.created.password ? "created" : "preserved"}: ${result.passwordPath}`);
  console.log(`Vault key file ${result.created.vaultKey ? "created" : "preserved"}: ${result.vaultKeyPath}`);
  console.log("No secret value was printed. Read the administrative password directly from its file only when the operator needs to sign in.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
