import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAgentParams,
  type GatewayRequestClient,
  isArchivedSessionGatewayError,
  materializeRunCredentialFile,
  requestAgentWithArchivedSessionRecovery,
  resolveClaimedApiKeyPath,
  resolveSessionKey,
} from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});

describe("archived issue session recovery", () => {
  const sessionKey = "agent:macgyver:paperclip:issue:issue-456";
  const archivedError = () => Object.assign(
    new Error(`Session "${sessionKey}" is archived. Restore it before starting new work.`),
    { gatewayCode: "INVALID_REQUEST" },
  );

  it("recognizes only the exact archived-session rejection for the requested key", () => {
    expect(isArchivedSessionGatewayError(archivedError(), sessionKey)).toBe(true);
    expect(isArchivedSessionGatewayError(archivedError(), `${sessionKey}-other`)).toBe(false);
    expect(
      isArchivedSessionGatewayError(
        Object.assign(archivedError(), { gatewayCode: "PERMISSION_DENIED" }),
        sessionKey,
      ),
    ).toBe(false);
  });

  it("restores an archived issue session and retries the same dispatch once", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let agentAttempts = 0;
    const client: GatewayRequestClient = {
      async request<T>(method: string, requestParams: unknown): Promise<T> {
        calls.push({ method, params: requestParams });
        if (method === "agent") {
          agentAttempts += 1;
          if (agentAttempts === 1) throw archivedError();
          return { status: "accepted", runId: "provider-run" } as T;
        }
        if (method === "sessions.describe") {
          return {
            session: { key: sessionKey, sessionId: "session-789", archived: true },
          } as T;
        }
        if (method === "sessions.patch") {
          return { ok: true, entry: {} } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };

    const logs: string[] = [];
    const result = await requestAgentWithArchivedSessionRecovery<Record<string, unknown>>({
      client,
      agentParams: { sessionKey, idempotencyKey: "run-123" },
      agentId: "macgyver",
      sessionKey,
      timeoutMs: 10_000,
      restoreArchivedIssueSession: true,
      onLog: async (_stream, text) => {
        logs.push(text);
      },
    });

    expect(result).toEqual({ status: "accepted", runId: "provider-run" });
    expect(calls).toEqual([
      {
        method: "agent",
        params: { sessionKey, idempotencyKey: "run-123" },
      },
      {
        method: "sessions.describe",
        params: { key: sessionKey, agentId: "macgyver" },
      },
      {
        method: "sessions.patch",
        params: {
          key: sessionKey,
          agentId: "macgyver",
          expectedSessionId: "session-789",
          archived: false,
        },
      },
      {
        method: "agent",
        params: { sessionKey, idempotencyKey: "run-123" },
      },
    ]);
    expect(logs.join("\n")).toContain("restoring archived issue session");
    expect(logs.join("\n")).toContain("retrying dispatch once");
  });

  it("does not restore archived sessions outside issue-scoped routing", async () => {
    const calls: string[] = [];
    const client: GatewayRequestClient = {
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        throw archivedError();
      },
    };

    await expect(
      requestAgentWithArchivedSessionRecovery({
        client,
        agentParams: { sessionKey },
        sessionKey,
        timeoutMs: 10_000,
        restoreArchivedIssueSession: false,
        onLog: async () => {},
      }),
    ).rejects.toThrow("is archived");
    expect(calls).toEqual(["agent"]);
  });

  it("fails closed when the archived session identity cannot be fenced", async () => {
    const calls: string[] = [];
    const client: GatewayRequestClient = {
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "agent") throw archivedError();
        if (method === "sessions.describe") {
          return {
            session: { key: sessionKey, sessionId: "session-789", archived: false },
          } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };

    await expect(
      requestAgentWithArchivedSessionRecovery({
        client,
        agentParams: { sessionKey },
        agentId: "macgyver",
        sessionKey,
        timeoutMs: 10_000,
        restoreArchivedIssueSession: true,
        onLog: async () => {},
      }),
    ).rejects.toThrow("did not describe the expected archived session");
    expect(calls).toEqual(["agent", "sessions.describe"]);
  });

  it("does not retry dispatch when cancellation arrives during restoration", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const client: GatewayRequestClient = {
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "agent") throw archivedError();
        if (method === "sessions.describe") {
          return {
            session: { key: sessionKey, sessionId: "session-789", archived: true },
          } as T;
        }
        if (method === "sessions.patch") {
          controller.abort();
          return { ok: true, entry: {} } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };

    await expect(
      requestAgentWithArchivedSessionRecovery({
        client,
        agentParams: { sessionKey },
        sessionKey,
        timeoutMs: 10_000,
        restoreArchivedIssueSession: true,
        signal: controller.signal,
        onLog: async () => {},
      }),
    ).rejects.toThrow("Stopped after restoring archived OpenClaw session");
    expect(calls).toEqual(["agent", "sessions.describe", "sessions.patch"]);
  });
});

describe("resolveClaimedApiKeyPath", () => {
  const DEFAULT_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  it("returns the configured per-agent path when set", () => {
    expect(
      resolveClaimedApiKeyPath("~/.openclaw/workspace/paperclip-keys/happy.json"),
    ).toBe("~/.openclaw/workspace/paperclip-keys/happy.json");
  });

  it("falls back to the shared default when value is empty", () => {
    expect(resolveClaimedApiKeyPath("")).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath("   ")).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is missing", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath(null)).toBe(DEFAULT_PATH);
  });

  it("falls back to the shared default when value is not a string", () => {
    expect(resolveClaimedApiKeyPath(42)).toBe(DEFAULT_PATH);
    expect(resolveClaimedApiKeyPath({})).toBe(DEFAULT_PATH);
  });
});

describe("materializeRunCredentialFile", () => {
  it("creates a private run-scoped credential beside the configured anchor and revokes it on cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-openclaw-credential-"));
    try {
      const lease = await materializeRunCredentialFile({
        authToken: "secret-run-token",
        runId: "run/123",
        claimedApiKeyPath: path.join(root, "claimed.json"),
      });

      expect(path.dirname(lease.path)).toBe(root);
      expect(path.basename(lease.path)).toBe(".paperclip-run-run_123.key");
      expect(await readFile(lease.path, "utf8")).toBe("secret-run-token\n");
      expect((await stat(lease.path)).mode & 0o777).toBe(0o600);

      await lease.cleanup();
      await expect(stat(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
