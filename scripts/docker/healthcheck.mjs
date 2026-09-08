const port = Number(process.env.CSB_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CSB_PORT must be a valid TCP port");
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4_000);

try {
  const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(`readyz returned HTTP ${response.status}`);
  }
} finally {
  clearTimeout(timeout);
}
