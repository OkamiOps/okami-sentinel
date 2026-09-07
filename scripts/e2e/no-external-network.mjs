import fs from "node:fs";

const logPath = requiredEnvironment("CSB_E2E_NETWORK_LOG");
const nativeFetch = globalThis.fetch;
const fixtureCatalog = {
  data: [
    {
      id: "openai/gpt-5.6-sol",
      pricing: {
        prompt: "0.000005",
        completion: "0.00003",
        input_cache_read: "0.0000005",
        input_cache_write: "0.00000625",
      },
    },
    {
      id: "openai/gpt-5.6-terra",
      pricing: {
        prompt: "0.000001",
        completion: "0.000006",
        input_cache_read: "0.0000001",
        input_cache_write: "0.00000125",
      },
    },
  ],
};

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the E2E network guard`);
  return value;
}

function requestUrl(input) {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

function record(action, url) {
  fs.appendFileSync(logPath, `${JSON.stringify({ action, url })}${String.fromCharCode(10)}`, { mode: 0o600 });
}

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  const parsed = new URL(url);
  if (parsed.origin === "https://openrouter.ai" && parsed.pathname === "/api/v1/models") {
    record("stubbed", url);
    return new Response(JSON.stringify(fixtureCatalog), {
      headers: { "content-type": "application/json" },
    });
  }
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1") {
    return nativeFetch(input, init);
  }
  record("blocked", url);
  throw new TypeError(`E2E network guard blocked ${url}`);
};
