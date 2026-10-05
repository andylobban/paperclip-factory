import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const websocketState = vi.hoisted(() => ({
  connectionAttempts: 0,
  failConnectAttempts: 0,
  failAgentRequests: 0,
  events: [] as string[],
  messages: [] as string[],
}));

let credentialRoot: string;

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    readonly attempt: number;

    constructor() {
      super();
      this.attempt = ++websocketState.connectionAttempts;
      websocketState.events.push(`construct:${this.attempt}`);
      queueMicrotask(() => {
        if (this.attempt <= websocketState.failConnectAttempts) {
          this.emit("error", new Error("ECONNREFUSED"));
          return;
        }
        this.emit("open");
        this.emit("message", JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }));
      });
    }

    send(payload: string) {
      const request = JSON.parse(payload) as { id: string; method: string; params?: { message?: string } };
      if (request.method === "agent") websocketState.messages.push(request.params?.message ?? "");
      websocketState.events.push(`send:${request.method}`);
      if (request.method === "agent" && websocketState.failAgentRequests > 0) {
        websocketState.failAgentRequests--;
        queueMicrotask(() => {
          this.emit("close", 1006, Buffer.from("ECONNRESET"));
        });
        return;
      }
      const responsePayload = request.method === "connect"
        ? { protocol: 3 }
        : { status: "ok", runId: "remote-run-1", summary: "done" };
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "res",
          id: request.id,
          ok: true,
          payload: responsePayload,
        }));
      });
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";

function createContext(input: {
  onDispatch?: () => void;
  onLog?: AdapterExecutionContext["onLog"];
} = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "ws://127.0.0.1:18789",
      disableDeviceAuth: true,
      timeoutSec: 1,
      claimedApiKeyPath: path.join(credentialRoot, "claimed.json"),
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "interaction_resolved",
    },
    onLog: input.onLog ?? (async () => {}),
    onDispatch: input.onDispatch,
    authToken: "run-secret-token",
  };
}

describe("openclaw_gateway execute dispatch boundary", () => {
  beforeEach(async () => {
    credentialRoot = await mkdtemp(path.join(tmpdir(), "paperclip-openclaw-run-"));
    websocketState.connectionAttempts = 0;
    websocketState.failConnectAttempts = 0;
    websocketState.failAgentRequests = 0;
    websocketState.events = [];
    websocketState.messages = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(credentialRoot, { recursive: true, force: true });
  });

  it("fails before gateway dispatch when a task-scoped credential is missing", async () => {
    const ctx = createContext();
    delete ctx.authToken;
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_task_credential_missing",
    });
    expect(websocketState.connectionAttempts).toBe(0);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("delivers the credential through a run-scoped file without prompt or log exposure", async () => {
    const logs: string[] = [];
    const result = await execute(createContext({
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    }));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(websocketState.messages).toHaveLength(1);
    expect(websocketState.messages[0]).not.toContain("run-secret-token");
    expect(logs.join("\n")).not.toContain("run-secret-token");
    const credentialPath = websocketState.messages[0]!.match(
      /single line in ([^\s]+\.key)/,
    )?.[1];
    expect(credentialPath).toBeTruthy();
    await expect(import("node:fs/promises").then(({ stat }) => stat(credentialPath!)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("sends conversation policy without the issue-completion workflow (resumed=%s)", async (resumed) => {
    const ctx = createContext();
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      ...ctx.context,
      conversationMode: true,
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(websocketState.messages).toHaveLength(1);
    const prompt = websocketState.messages[0]!;
    expect(prompt).toContain(directive);
    expect(prompt).toContain("X-Paperclip-Run-Id");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
    expect(prompt).not.toContain('"status":"done"');
    expect(prompt).not.toContain("GET /api/issues/{issueId}/comments");
  });

  it("reports dispatch after transport setup and before the remote agent request", async () => {
    const onDispatch = vi.fn(() => {
      websocketState.events.push("dispatch");
    });

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(websocketState.events).toEqual([
      "construct:1",
      "send:connect",
      "dispatch",
      "send:agent",
    ]);
  });

  it("retains the continuation gate through transient connection backoff", async () => {
    vi.useFakeTimers();
    websocketState.failConnectAttempts = 1;
    let resolveBackoff!: () => void;
    const backoffReached = new Promise<void>((resolve) => {
      resolveBackoff = resolve;
    });
    let resolveAuthorityChange!: () => void;
    const authorityChange = new Promise<void>((resolve) => {
      resolveAuthorityChange = resolve;
    });
    const onDispatch = vi.fn(resolveAuthorityChange);
    const resultPromise = execute(createContext({
      onDispatch,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("transient error, retry")) resolveBackoff();
      },
    }));

    await backoffReached;
    expect(websocketState.connectionAttempts).toBe(1);
    expect(onDispatch).not.toHaveBeenCalled();

    let authorityChangeSettled = false;
    void authorityChange.then(() => {
      authorityChangeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(authorityChangeSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;
    await authorityChange;

    expect(result).toMatchObject({ exitCode: 0 });
    expect(websocketState.connectionAttempts).toBe(2);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(authorityChangeSettled).toBe(true);
  });

  it("does not retry after the remote-work boundary has been crossed", async () => {
    websocketState.failAgentRequests = 1;
    const onDispatch = vi.fn();

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_request_failed",
    });
    expect(websocketState.connectionAttempts).toBe(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });
});
