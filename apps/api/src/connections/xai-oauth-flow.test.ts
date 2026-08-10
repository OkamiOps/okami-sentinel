import assert from "node:assert/strict";
import test from "node:test";

import {
  XAI_PUBLIC_OAUTH_PRESET,
  XaiOAuthFlowError,
  createXaiOAuthFlow,
  type XaiOAuthCredentialStore,
  type XaiOAuthTransport,
} from "./xai-oauth-flow.js";

class MemoryCredentialStore implements XaiOAuthCredentialStore {
  readonly values = new Map<string, {
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  }>();
  readonly writes: string[] = [];

  async put(connectionId: string, value: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  }) {
    this.writes.push(connectionId);
    this.values.set(connectionId, { ...value });
  }

  async get(connectionId: string) {
    return this.values.get(connectionId) ?? null;
  }

  async delete(connectionId: string) {
    this.values.delete(connectionId);
  }
}

test("xAI device OAuth uses the pinned public client, persistent slow-down, and vault-only credentials", async () => {
  const calls: Array<{ kind: string; url: string; grantType?: string }> = [];
  const sleeps: number[] = [];
  const credentialStore = new MemoryCredentialStore();
  const transport: XaiOAuthTransport = {
    async requestDeviceCode(input) {
      calls.push({ kind: "device", url: input.url });
      assert.equal(input.clientId, "b1a00492-073a-47ea-816f-4c329264a828");
      assert.equal(input.scope, "openid profile email offline_access grok-cli:access api:access");
      return {
        deviceCode: "private-device-code",
        verificationUri: "https://auth.x.ai/activate",
        verificationUriComplete: "https://auth.x.ai/activate?code=private-device-code",
        userCode: "ABCD-1234",
        expiresIn: 300,
        interval: 0,
      };
    },
    async requestToken(input) {
      calls.push({ kind: "token", url: input.url, grantType: input.grantType });
      if (calls.filter((call) => call.kind === "token").length === 1) {
        return { error: "authorization_pending" };
      }
      if (calls.filter((call) => call.kind === "token").length === 2) {
        return { error: "slow_down" };
      }
      return {
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresIn: 3600,
      };
    },
    async revoke() {
      throw new Error("not used");
    },
  };
  const opened: string[] = [];
  const flow = createXaiOAuthFlow({
    transport,
    credentialStore,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });

  const started = await flow.start("conn-xai");
  const completed = await flow.waitForTerminal("conn-xai", started.flowId);

  assert.deepEqual(XAI_PUBLIC_OAUTH_PRESET, {
    issuer: "https://auth.x.ai",
    deviceAuthorizationPath: "/oauth2/device/code",
    tokenPath: "/oauth2/token",
    revocationPath: "/oauth2/revoke",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: "openid profile email offline_access grok-cli:access api:access",
    inferenceOrigin: "https://api.x.ai",
    modelsPath: "/v1/models",
    responsesPath: "/v1/responses",
    allowedOrigins: ["https://auth.x.ai", "https://api.x.ai"],
  });
  assert.deepEqual(calls, [
    { kind: "device", url: "https://auth.x.ai/oauth2/device/code" },
    {
      kind: "token",
      url: "https://auth.x.ai/oauth2/token",
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
    {
      kind: "token",
      url: "https://auth.x.ai/oauth2/token",
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
    {
      kind: "token",
      url: "https://auth.x.ai/oauth2/token",
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    },
  ]);
  assert.deepEqual(sleeps, [5_000, 5_000, 10_000]);
  assert.deepEqual(opened, ["https://auth.x.ai/activate?code=private-device-code"]);
  assert.deepEqual(started, {
    flowId: started.flowId,
    status: "pending-device",
    verificationUrl: "https://auth.x.ai/activate",
    userCode: "ABCD-1234",
    expiresAt: started.expiresAt,
  });
  assert.deepEqual(completed, {
    flowId: started.flowId,
    status: "completed",
    verificationUrl: "https://auth.x.ai/activate",
    userCode: "ABCD-1234",
    expiresAt: started.expiresAt,
  });
  assert.deepEqual(credentialStore.values.get("conn-xai"), {
    accessToken: "private-access-token",
    refreshToken: "private-refresh-token",
    expiresAt: credentialStore.values.get("conn-xai")?.expiresAt ?? null,
  });
  assert.equal(JSON.stringify({ started, completed }).includes("private-device-code"), false);
  assert.equal(JSON.stringify({ started, completed }).includes("private-access-token"), false);
  assert.equal(JSON.stringify({ started, completed }).includes("?code="), false);
});

test("an uncertain refresh result fails closed instead of reusing a possibly rotated refresh token", async () => {
  const credentialStore = new MemoryCredentialStore();
  await credentialStore.put("conn-xai", {
    accessToken: "expired-access-token",
    refreshToken: "possibly-rotated-refresh-token",
    expiresAt: "2026-08-10T00:00:00.000Z",
  });
  let refreshAttempts = 0;
  const flow = createXaiOAuthFlow({
    credentialStore,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    transport: {
      async requestDeviceCode() {
        throw new Error("not used");
      },
      async requestToken() {
        refreshAttempts += 1;
        throw new Error("connection reset after upstream token rotation");
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  await assert.rejects(flow.getAccessToken("conn-xai"), (error: unknown) => {
    assert.equal(error instanceof XaiOAuthFlowError, true);
    assert.equal((error as XaiOAuthFlowError).code, "credential_expired");
    assert.equal(String(error).includes("connection reset"), false);
    return true;
  });

  assert.equal(refreshAttempts, 1);
  assert.equal(credentialStore.values.has("conn-xai"), false);
});

test("xAI honors a positive provider polling interval and only defaults malformed values to five seconds", async () => {
  const credentialStore = new MemoryCredentialStore();
  const sleeps: number[] = [];
  const flow = createXaiOAuthFlow({
    credentialStore,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    transport: {
      async requestDeviceCode() {
        return {
          deviceCode: "private-device-code",
          verificationUri: "https://auth.x.ai/activate",
          userCode: "XAI-2222",
          expiresIn: 300,
          interval: 1,
        };
      },
      async requestToken() {
        return {
          accessToken: "private-access-token",
          refreshToken: "private-refresh-token",
          expiresIn: 3600,
        };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  const started = await flow.start("conn-xai");
  await flow.waitForTerminal("conn-xai", started.flowId);

  assert.deepEqual(sleeps, [1_000]);
});

test("a terminal xAI flow remains readable only through its safe public snapshot", async () => {
  const credentialStore = new MemoryCredentialStore();
  const flow = createXaiOAuthFlow({
    credentialStore,
    sleep: async () => undefined,
    transport: {
      async requestDeviceCode() {
        return {
          deviceCode: "private-one-time-device-code",
          verificationUri: "https://auth.x.ai/activate",
          verificationUriComplete: "https://auth.x.ai/activate?code=private-one-time-device-code",
          userCode: "XAI-4444",
          expiresIn: 300,
        };
      },
      async requestToken() {
        return {
          accessToken: "private-access-token",
          refreshToken: "private-refresh-token",
          expiresIn: 3600,
        };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  const started = await flow.start("conn-xai");
  const terminal = await flow.waitForTerminal("conn-xai", started.flowId);
  const later = flow.get("conn-xai", started.flowId);

  assert.equal(terminal.status, "completed");
  assert.deepEqual(later, terminal);
  assert.equal(JSON.stringify(later).includes("private-one-time-device-code"), false);
  assert.equal(JSON.stringify(later).includes("private-access-token"), false);
  assert.equal(JSON.stringify(later).includes("?code="), false);
});

test("disconnect cannot let an in-flight device exchange resurrect a revoked local credential", async () => {
  const credentialStore = new MemoryCredentialStore();
  let tokenRequestedResolve: (() => void) | undefined;
  const tokenRequested = new Promise<void>((resolve) => {
    tokenRequestedResolve = resolve;
  });
  let tokenResolve: ((value: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }) => void) | undefined;
  const token = new Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>((resolve) => {
    tokenResolve = resolve;
  });
  const flow = createXaiOAuthFlow({
    credentialStore,
    sleep: async () => undefined,
    transport: {
      async requestDeviceCode() {
        return {
          deviceCode: "private-device-code",
          verificationUri: "https://auth.x.ai/activate",
          userCode: "XAI-3333",
          expiresIn: 300,
        };
      },
      async requestToken() {
        tokenRequestedResolve?.();
        return token;
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  const started = await flow.start("conn-xai");
  await tokenRequested;
  assert.equal(await flow.disconnect("conn-xai"), "local_removed");
  tokenResolve?.({
    accessToken: "late-access-token",
    refreshToken: "late-refresh-token",
    expiresIn: 3600,
  });
  const terminal = await flow.waitForTerminal("conn-xai", started.flowId);

  assert.equal(terminal.status, "cancelled");
  assert.equal(credentialStore.values.has("conn-xai"), false);
});

test("cancelling a flow settles waiters when an injected token request ignores AbortSignal", async () => {
  const credentialStore = new MemoryCredentialStore();
  let tokenStartedResolve: (() => void) | undefined;
  const tokenStarted = new Promise<void>((resolve) => {
    tokenStartedResolve = resolve;
  });
  const flow = createXaiOAuthFlow({
    credentialStore,
    sleep: async () => undefined,
    transport: {
      async requestDeviceCode() {
        return {
          deviceCode: "private-device-code",
          verificationUri: "https://auth.x.ai/activate",
          userCode: "XAI-5555",
          expiresIn: 300,
        };
      },
      async requestToken() {
        tokenStartedResolve?.();
        return new Promise(() => undefined);
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  const started = await flow.start("conn-xai");
  await tokenStarted;
  const waiting = flow.waitForTerminal("conn-xai", started.flowId);
  const result = await Promise.race([
    flow.cancel("conn-xai", started.flowId).then(() => waiting),
    delay(50).then(() => "timed-out" as const),
  ]);

  assert.notEqual(result, "timed-out");
  assert.equal((result as { status: string }).status, "cancelled");
});

test("pinned OAuth metadata failures remain a safe metadata error instead of an ambiguous network error", async () => {
  const flow = createXaiOAuthFlow({
    credentialStore: new MemoryCredentialStore(),
    transport: {
      async requestDeviceCode() {
        throw new XaiOAuthFlowError("oauth_metadata_invalid");
      },
      async requestToken() {
        throw new Error("not used");
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  await assert.rejects(flow.start("conn-xai"), (error: unknown) => {
    assert.equal(error instanceof XaiOAuthFlowError, true);
    assert.equal((error as XaiOAuthFlowError).code, "oauth_metadata_invalid");
    return true;
  });
});

test("expired xAI credentials refresh once, rotate before use, and keep the bearer private", async () => {
  const credentialStore = new MemoryCredentialStore();
  await credentialStore.put("conn-xai", {
    accessToken: "expired-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: "2026-08-10T00:00:00.000Z",
  });
  let refreshCalls = 0;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flow = createXaiOAuthFlow({
    credentialStore,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    transport: {
      async requestDeviceCode() {
        throw new Error("not used");
      },
      async requestToken() {
        refreshCalls += 1;
        await wait;
        return {
          accessToken: "fresh-access-token",
          refreshToken: "rotated-refresh-token",
          expiresIn: 3600,
        };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
  });

  const first = flow.getAccessToken("conn-xai");
  const second = flow.getAccessToken("conn-xai");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  release?.();

  assert.deepEqual(await Promise.all([first, second]), ["fresh-access-token", "fresh-access-token"]);
  assert.deepEqual(credentialStore.values.get("conn-xai"), {
    accessToken: "fresh-access-token",
    refreshToken: "rotated-refresh-token",
    expiresAt: credentialStore.values.get("conn-xai")?.expiresAt ?? null,
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
