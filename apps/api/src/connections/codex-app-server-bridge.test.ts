import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexAppServerBridge,
  createCodexAppServerJsonRpc,
  type AppServerJsonRpc,
  type AppServerLineTransport,
  type CodexAppServerStateSink,
} from "./codex-app-server-bridge.js";

class FakeJsonRpc implements AppServerJsonRpc {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "account/login/start") {
      return {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        accessToken: "must-not-leave-codex",
      };
    }
    throw new Error(`unexpected method: ${method}`);
  }
}

class ScriptedJsonRpc implements AppServerJsonRpc {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  #notificationListener: ((notification: { method: string; params: Record<string, unknown> }) => void) | undefined;

  constructor(private readonly responses: unknown[]) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }

  onNotification(listener: (notification: { method: string; params: Record<string, unknown> }) => void) {
    this.#notificationListener = listener;
    return () => {
      this.#notificationListener = undefined;
    };
  }

  notify(method: string, params: Record<string, unknown>) {
    this.#notificationListener?.({ method, params });
  }
}

class FakeLineTransport implements AppServerLineTransport {
  readonly sent: string[] = [];
  #lineListener: ((line: string) => void) | undefined;
  #closeListener: ((error?: Error) => void) | undefined;

  send(line: string) {
    this.sent.push(line);
  }

  onLine(listener: (line: string) => void) {
    this.#lineListener = listener;
    return () => {
      this.#lineListener = undefined;
    };
  }

  onClose(listener: (error?: Error) => void) {
    this.#closeListener = listener;
    return () => {
      this.#closeListener = undefined;
    };
  }

  close() {
    this.#closeListener?.();
  }

  receive(value: unknown) {
    this.#lineListener?.(JSON.stringify(value));
  }
}

class FakeStateSink implements CodexAppServerStateSink {
  readonly states: Array<{
    loginId: string | null;
    status: string;
    planLabel: string | null;
    syncedAt: string;
  }> = [];

  record(state: { loginId: string | null; status: string; planLabel: string | null; syncedAt: string }) {
    this.states.push({ ...state });
  }
}

test("Codex device login forwards only safe flow fields and Codex owns the credential", async () => {
  const rpc = new FakeJsonRpc();
  const bridge = new CodexAppServerBridge(rpc);

  assert.deepEqual(await bridge.startDeviceLogin(), {
    loginId: "login-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });
  assert.equal(rpc.requests[0]?.params.type, "chatgptDeviceCode");
  assert.equal(JSON.stringify(rpc.requests).includes("accessToken"), false);
});

test("Codex model list follows cursors and returns only app-server-reported IDs", async () => {
  const rpc = new ScriptedJsonRpc([
    { data: [{ id: "account-visible-a", name: "Account visible A" }], nextCursor: "page-2" },
    { data: [{ id: "account-visible-b" }] },
  ]);
  const bridge = new CodexAppServerBridge(rpc);

  const models = await bridge.listModels();

  assert.deepEqual(models, [
    { id: "account-visible-a", displayName: "Account visible A" },
    { id: "account-visible-b", displayName: "account-visible-b" },
  ]);
  assert.deepEqual(rpc.requests, [
    { method: "model/list", params: {} },
    { method: "model/list", params: { cursor: "page-2" } },
  ]);
});

test("Codex notifications retain only the safe login status and cancellation uses loginId", async () => {
  const rpc = new ScriptedJsonRpc([
    {
      type: "chatgptDeviceCode",
      loginId: "login-2",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "EFGH-5678",
    },
    {},
  ]);
  const bridge = new CodexAppServerBridge(rpc);

  await bridge.startDeviceLogin();
  rpc.notify("account/login/completed", { loginId: "login-2", status: "expired" });
  assert.deepEqual(bridge.getLoginFlow("login-2"), {
    flowId: "login-2",
    status: "expired",
  });
  assert.equal(JSON.stringify(bridge.getLoginFlow("login-2")).includes("EFGH-5678"), false);

  await bridge.cancelLogin("login-2");
  assert.deepEqual(rpc.requests.at(-1), {
    method: "account/login/cancel",
    params: { loginId: "login-2" },
  });
  assert.deepEqual(bridge.getLoginFlow("login-2"), {
    flowId: "login-2",
    status: "cancelled",
  });

  rpc.notify("account/login/completed", {
    loginId: "login-2",
    success: false,
    error: "cancelled by user",
  });
  assert.deepEqual(bridge.getLoginFlow("login-2"), {
    flowId: "login-2",
    status: "cancelled",
  });
});

test("Codex account inspection drops identity fields and reports expiry safely", async () => {
  const rpc = new ScriptedJsonRpc([
    { account: { status: "expired", email: "person@example.test", planType: "pro" } },
  ]);
  const bridge = new CodexAppServerBridge(rpc);

  const account = await bridge.readAccount();

  assert.deepEqual(account, {
    status: "expired",
    planLabel: "pro",
    syncedAt: account.syncedAt,
  });
  assert.equal(JSON.stringify(account).includes("person@example.test"), false);
});

test("Codex app-server failures are normalized without retaining raw output", async () => {
  const marker = "app-server-access-token-marker";
  const rpc = new ScriptedJsonRpc([new Error(`stale app server Authorization: Bearer ${marker}`)]);
  const bridge = new CodexAppServerBridge(rpc);

  await assert.rejects(bridge.readAccount(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "provider_unreachable");
    assert.equal(String(error).includes(marker), false);
    return true;
  });
});

test("Codex JSON-RPC client completes initialize/initialized before account calls", async () => {
  const transport = new FakeLineTransport();
  const rpc = createCodexAppServerJsonRpc({ transport });
  let notification: { method: string; params: Record<string, unknown> } | undefined;
  rpc.onNotification((value) => {
    notification = value;
  });

  const pending = rpc.request("account/read", {});
  const initialize = JSON.parse(transport.sent[0] ?? "{}") as { id: number; method: string; jsonrpc?: string };
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.jsonrpc, undefined);
  transport.receive({ id: initialize.id, result: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const initialized = JSON.parse(transport.sent[1] ?? "{}") as {
    id?: number;
    method?: string;
    params?: unknown;
    jsonrpc?: string;
  };
  assert.deepEqual(initialized, { method: "initialized" });

  const accountRead = JSON.parse(transport.sent[2] ?? "{}") as { id: number; method: string };
  assert.equal(accountRead.method, "account/read");
  transport.receive({ id: accountRead.id, result: { account: null } });
  assert.deepEqual(await pending, { account: null });

  transport.receive({ method: "account/updated", params: { status: "ready" } });
  assert.deepEqual(notification, { method: "account/updated", params: { status: "ready" } });
  rpc.close();
});

test("Codex maps official account/updated authMode and logout without retaining identity", () => {
  const states = new FakeStateSink();
  const rpc = new ScriptedJsonRpc([]);
  new CodexAppServerBridge(rpc, {
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    stateSink: states,
  });

  rpc.notify("account/updated", {
    authMode: "chatgpt",
    planType: "pro",
    email: "person@example.test",
  });
  rpc.notify("account/updated", { authMode: null, planType: null });

  assert.deepEqual(states.states, [
    { loginId: null, status: "ready", planLabel: "pro", syncedAt: "2026-08-11T00:00:00.000Z" },
    {
      loginId: null,
      status: "authentication-required",
      planLabel: null,
      syncedAt: "2026-08-11T00:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(states.states).includes("person@example.test"), false);
});

test("Codex persists only safe login/account state and keeps browser/device handoffs ephemeral", async () => {
  const states = new FakeStateSink();
  const rpc = new ScriptedJsonRpc([
    {
      type: "chatgptDeviceCode",
      loginId: "login-3",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "IJKL-9012",
    },
    { account: { status: "expired", planType: "pro", email: "person@example.test" } },
  ]);
  const bridge = new CodexAppServerBridge(rpc, {
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    stateSink: states,
  });

  await bridge.startDeviceLogin();
  await bridge.readAccount();

  assert.deepEqual(states.states, [
    { loginId: "login-3", status: "pending", planLabel: null, syncedAt: "2026-08-11T00:00:00.000Z" },
    { loginId: null, status: "expired", planLabel: "pro", syncedAt: "2026-08-11T00:00:00.000Z" },
  ]);
  assert.equal(JSON.stringify(states.states).includes("IJKL-9012"), false);
  assert.equal(JSON.stringify(states.states).includes("person@example.test"), false);
});
