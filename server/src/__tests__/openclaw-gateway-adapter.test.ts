import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { execute, testEnvironment } from "@paperclipai/adapter-openclaw-gateway/server";
import {
  buildOpenClawGatewayConfig,
  parseOpenClawGatewayStdoutLine,
} from "@paperclipai/adapter-openclaw-gateway/ui";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const credentialDirectories = new Set<string>();

function createClaimedApiKeyPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-openclaw-adapter-test-"));
  credentialDirectories.add(directory);
  return path.join(directory, "claimed-api-key");
}

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "OpenClaw Gateway Agent",
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
      claimedApiKeyPath: createClaimedApiKeyPath(),
      ...config,
    },
    context: {
      taskId: "task-123",
      issueId: "issue-123",
      wakeReason: "issue_assigned",
      issueIds: ["issue-123"],
    },
    authToken: "paperclip-run-jwt",
    onLog: async () => {},
    ...overrides,
  };
}

async function createMockGatewayServer(options?: {
  waitPayload?: Record<string, unknown>;
  holdWait?: boolean;
  waitResponseDelayMs?: number;
  emitAgentEvents?: boolean;
  abortResponsePayload?: Record<string, unknown>;
  settleAfterAbort?: boolean;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let agentPayload: Record<string, unknown> | null = null;
  let abortPayload: Record<string, unknown> | null = null;
  let waitRequestCount = 0;
  const heldWaitRequestIds: string[] = [];

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait", "sessions.abort"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayload = frame.params ?? null;
        const runId =
          typeof frame.params?.idempotencyKey === "string"
            ? frame.params.idempotencyKey
            : "run-123";

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );

        if (options?.emitAgentEvents !== false) {
          socket.send(
            JSON.stringify({
              type: "event",
              event: "agent",
              payload: {
                runId,
                seq: 1,
                stream: "assistant",
                ts: Date.now(),
                data: { delta: "cha" },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "event",
              event: "agent",
              payload: {
                runId,
                seq: 2,
                stream: "assistant",
                ts: Date.now(),
                data: { delta: "chacha" },
              },
            }),
          );
        }
        return;
      }

      if (frame.method === "agent.wait") {
        waitRequestCount += 1;
        if (abortPayload && options?.settleAfterAbort !== false) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                runId: frame.params?.runId,
                status: "cancelled",
                endedAt: Date.now(),
              },
            }),
          );
          return;
        }
        if (options?.holdWait) {
          heldWaitRequestIds.push(frame.id);
          return;
        }
        const sendWaitResponse = () => {
          if (socket.readyState !== 1) return;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: options?.waitPayload ?? {
                runId: frame.params?.runId,
                status: "ok",
                startedAt: 1,
                endedAt: 2,
              },
            }),
          );
        };
        if (options?.waitResponseDelayMs) {
          setTimeout(sendWaitResponse, options.waitResponseDelayMs);
        } else {
          sendWaitResponse();
        }
        return;
      }

      if (frame.method === "sessions.abort") {
        abortPayload = frame.params ?? null;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: options?.abortResponsePayload ?? {
              ok: true,
              status: "aborted",
              abortedRunId: frame.params?.runId,
            },
          }),
        );
        if (options?.settleAfterAbort !== false) {
          for (const waitRequestId of heldWaitRequestIds.splice(0)) {
            socket.send(
              JSON.stringify({
                type: "res",
                id: waitRequestId,
                ok: true,
                payload: {
                  runId: frame.params?.runId,
                  status: "cancelled",
                  endedAt: Date.now(),
                },
              }),
            );
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayload: () => agentPayload,
    getAbortPayload: () => abortPayload,
    getWaitRequestCount: () => waitRequestCount,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createMockGatewayServerWithPairing() {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  let agentPayload: Record<string, unknown> | null = null;
  let approved = false;
  let pendingRequestId = "req-1";
  let lastSeenDeviceId: string | null = null;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        const device = frame.params?.device as Record<string, unknown> | undefined;
        const deviceId = typeof device?.id === "string" ? device.id : null;
        if (deviceId) {
          lastSeenDeviceId = deviceId;
        }

        if (deviceId && !approved) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "NOT_PAIRED",
                message: "pairing required",
                details: {
                  code: "PAIRING_REQUIRED",
                  requestId: pendingRequestId,
                  reason: "not-paired",
                },
              },
            }),
          );
          socket.close(1008, "pairing required");
          return;
        }

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: {
                methods: ["connect", "agent", "agent.wait", "device.pair.list", "device.pair.approve"],
                events: ["agent"],
              },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "device.pair.list") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              pending: approved
                ? []
                : [
                    {
                      requestId: pendingRequestId,
                      deviceId: lastSeenDeviceId ?? "device-unknown",
                    },
                  ],
              paired: approved && lastSeenDeviceId ? [{ deviceId: lastSeenDeviceId }] : [],
            },
          }),
        );
        return;
      }

      if (frame.method === "device.pair.approve") {
        const requestId = frame.params?.requestId;
        if (requestId !== pendingRequestId) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message: "unknown requestId" },
            }),
          );
          return;
        }
        approved = true;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              requestId: pendingRequestId,
              device: {
                deviceId: lastSeenDeviceId ?? "device-unknown",
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayload = frame.params ?? null;
        const runId =
          typeof frame.params?.idempotencyKey === "string"
            ? frame.params.idempotencyKey
            : "run-123";

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              seq: 1,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "ok" },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId: frame.params?.runId,
              status: "ok",
              startedAt: 1,
              endedAt: 2,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayload: () => agentPayload,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  for (const directory of credentialDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  credentialDirectories.clear();
});

describe("openclaw gateway ui stdout parser", () => {
  it("parses assistant deltas from gateway event lines", () => {
    const ts = "2026-03-06T15:00:00.000Z";
    const line =
      '[openclaw-gateway:event] run=run-1 stream=assistant data={"delta":"hello"}';

    expect(parseOpenClawGatewayStdoutLine(line, ts)).toEqual([
      {
        kind: "assistant",
        ts,
        text: "hello",
        delta: true,
      },
    ]);
  });
});

describe("openclaw gateway adapter execute", () => {
  it("fails closed when a task-scoped Paperclip credential is missing", async () => {
    const result = await execute(
      buildContext(
        { url: "ws://127.0.0.1:1" },
        { authToken: undefined },
      ),
    );

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorCode: "openclaw_gateway_task_credential_missing",
    });
  });

  it("runs connect -> agent -> agent.wait and forwards wake payload", async () => {
    const gateway = await createMockGatewayServer();
    const logs: string[] = [];
    const claimedApiKeyPath = createClaimedApiKeyPath();
    const credentialPath = path.join(
      path.dirname(claimedApiKeyPath),
      ".paperclip-run-run-123.key",
    );

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            headers: {
              "x-openclaw-token": "gateway-token",
            },
            payloadTemplate: {
              message: "wake now",
            },
            claimedApiKeyPath,
            waitTimeoutMs: 2000,
          },
          {
            onLog: async (_stream, chunk) => {
              logs.push(chunk);
            },
            context: {
              taskId: "task-123",
              issueId: "issue-123",
              wakeReason: "issue_assigned",
              issueIds: ["issue-123"],
              paperclipWorkspace: {
                cwd: "/tmp/worktrees/pap-123",
                strategy: "git_worktree",
                branchName: "pap-123-test",
              },
              paperclipWorkspaces: [
                {
                  id: "workspace-1",
                  cwd: "/tmp/project",
                },
              ],
              paperclipRuntimeServiceIntents: [
                {
                  name: "preview",
                  lifecycle: "ephemeral",
                },
              ],
              paperclipWake: {
                reason: "issue_commented",
                issue: {
                  id: "issue-123",
                  identifier: "PAP-874",
                  title: "chat-speed issues",
                  status: "in_progress",
                  priority: "medium",
                },
                commentIds: ["comment-1", "comment-2"],
                latestCommentId: "comment-2",
                comments: [
                  {
                    id: "comment-1",
                    issueId: "issue-123",
                    body: "First comment",
                    bodyTruncated: false,
                    createdAt: "2026-03-28T14:35:00.000Z",
                    author: { type: "user", id: "user-1" },
                  },
                  {
                    id: "comment-2",
                    issueId: "issue-123",
                    body: "Second comment",
                    bodyTruncated: false,
                    createdAt: "2026-03-28T14:35:10.000Z",
                    author: { type: "user", id: "user-1" },
                  },
                ],
                commentWindow: {
                  requestedCount: 2,
                  includedCount: 2,
                  missingCount: 0,
                },
                truncated: false,
                fallbackFetchNeeded: false,
              },
            },
          },
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.summary).toContain("chachacha");
      expect(result.provider).toBe("openclaw");

      const payload = gateway.getAgentPayload();
      expect(payload).toBeTruthy();
      expect(payload?.idempotencyKey).toBe("run-123");
      expect(payload?.sessionKey).toBe("paperclip:issue:issue-123");
      expect(String(payload?.message ?? "")).toContain("wake now");
      expect(String(payload?.message ?? "")).toContain("PAPERCLIP_RUN_ID=run-123");
      expect(String(payload?.message ?? "")).toContain("PAPERCLIP_TASK_ID=task-123");
      expect(String(payload?.message ?? "")).toContain(
        "only from the host-local bash/terminal tool",
      );
      expect(String(payload?.message ?? "")).toContain(
        "Do not use gateway_exec, node_exec",
      );
      expect(String(payload?.message ?? "")).toContain(
        `PAPERCLIP_API_KEY="$(tr -d '\\r\\n' < '${credentialPath}')"; export PAPERCLIP_API_KEY;`,
      );
      expect(String(payload?.message ?? "")).toContain(
        "Never use PAPERCLIP_API_KEY=$(...) curl",
      );
      expect(String(payload?.message ?? "")).toContain(
        "GET /api/issues/{issueId}/recovery-actions/diagnostic",
      );
      expect(String(payload?.message ?? "")).toContain(
        "POST /api/issues/{issueId}/recovery-actions/resolve",
      );
      expect(String(payload?.message ?? "")).toContain(
        "GET /api/issues/{issueId}/interactions",
      );
      expect(String(payload?.message ?? "")).toContain(
        "GET /api/heartbeat-runs/{runId}",
      );
      expect(String(payload?.message ?? "")).toContain(
        "POST /api/agents/{agentId}/wakeup",
      );
      expect(String(payload?.message ?? "")).toContain("## Paperclip Wake Payload");
      expect(String(payload?.message ?? "")).toContain(
        "Use this wake to continue the task, applying new user direction and preserving its approval gates.",
      );
      expect(String(payload?.message ?? "")).toContain(
        "Do not switch to another issue until you have handled this wake.",
      );
      expect(String(payload?.message ?? "")).toContain("First comment");
      expect(String(payload?.message ?? "")).toContain("\"commentIds\":[\"comment-1\",\"comment-2\"]");
      expect(payload?.paperclip).toBeUndefined();
      expect(String(payload?.message ?? "")).toContain("\"latestCommentId\":\"comment-2\"");

      expect(logs.some((entry) => entry.includes("[openclaw-gateway:event] run=run-123 stream=assistant"))).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("fails fast when url is missing", async () => {
    const result = await execute(buildContext({}));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_gateway_url_missing");
  });

  it("keeps the authoritative wait alive until a delayed terminal receipt arrives", async () => {
    const gateway = await createMockGatewayServer({
      waitResponseDelayMs: 1_100,
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          timeoutSec: 1,
          queueTimeoutMs: 2_000,
          idleTimeoutMs: 2_000,
          waitPollIntervalMs: 5,
        }),
      );

      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        resultJson: {
          providerSettlement: {
            state: "terminal",
            runId: "run-123",
            terminalStatus: "ok",
            source: "agent.wait",
          },
        },
      });
      expect(gateway.getWaitRequestCount()).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("still enforces the local queue deadline while the provider wait is held", async () => {
    const gateway = await createMockGatewayServer({
      holdWait: true,
      emitAgentEvents: false,
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          queueTimeoutMs: 40,
          idleTimeoutMs: 40,
          waitPollIntervalMs: 5,
          cancelSettlementTimeoutMs: 100,
        }),
      );

      expect(result).toMatchObject({
        timedOut: true,
        errorCode: "openclaw_gateway_wait_timeout",
        resultJson: {
          executionCancellation: { state: "acknowledged" },
          providerSettlement: {
            state: "terminal",
            runId: "run-123",
            terminalStatus: "cancelled",
          },
        },
      });
      expect(gateway.getAbortPayload()).toEqual({
        runId: "run-123",
        key: "paperclip:issue:issue-123",
        clearQueued: true,
      });
      expect(gateway.getWaitRequestCount()).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("aborts and verifies the remote run before returning a queue timeout", async () => {
    const gateway = await createMockGatewayServer({
      waitPayload: { runId: "run-123", status: "timeout" },
      emitAgentEvents: false,
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          waitTimeoutMs: 40,
          queueTimeoutMs: 40,
          idleTimeoutMs: 40,
          waitPollIntervalMs: 10,
        }),
      );

      expect(result).toMatchObject({
        timedOut: true,
        errorCode: "openclaw_gateway_wait_timeout",
        errorMessage: "OpenClaw gateway run did not start within 40ms",
        resultJson: {
          executionCancellation: {
            state: "acknowledged",
            providerMethod: "sessions.abort",
          },
          providerSettlement: {
            state: "terminal",
            runId: "run-123",
            terminalStatus: "cancelled",
          },
        },
      });
      expect(gateway.getWaitRequestCount()).toBeGreaterThan(1);
      expect(gateway.getAbortPayload()).toEqual({
        runId: "run-123",
        key: "paperclip:issue:issue-123",
        clearQueued: true,
      });
    } finally {
      await gateway.close();
    }
  });

  it("fails closed when a timeout cancellation is not acknowledged by the gateway", async () => {
    const gateway = await createMockGatewayServer({
      waitPayload: { runId: "run-123", status: "timeout" },
      emitAgentEvents: false,
      abortResponsePayload: { ok: true, status: "queued" },
      settleAfterAbort: false,
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          waitTimeoutMs: 40,
          queueTimeoutMs: 40,
          idleTimeoutMs: 40,
          waitPollIntervalMs: 10,
          cancelSettlementTimeoutMs: 50,
        }),
      );

      expect(result).toMatchObject({
        exitCode: 1,
        timedOut: true,
        errorCode: "openclaw_gateway_cancel_unverified",
        resultJson: {
          executionCancellation: {
            state: "requested",
            providerMethod: "sessions.abort",
            providerResult: { ok: true, status: "queued" },
          },
        },
      });
      expect(result.errorMessage).toContain("remote termination could not be verified");
    } finally {
      await gateway.close();
    }
  });

  it("does not treat an abort acknowledgement as terminal provider settlement", async () => {
    const gateway = await createMockGatewayServer({
      waitPayload: { runId: "run-123", status: "timeout" },
      emitAgentEvents: false,
      settleAfterAbort: false,
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          waitTimeoutMs: 30,
          queueTimeoutMs: 30,
          idleTimeoutMs: 30,
          waitPollIntervalMs: 10,
          cancelSettlementTimeoutMs: 50,
        }),
      );

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "openclaw_gateway_cancel_unverified",
        resultJson: {
          executionCancellation: {
            state: "requested",
            providerAcknowledgedAt: expect.any(String),
          },
        },
      });
      expect(result.resultJson).not.toHaveProperty("providerSettlement");
    } finally {
      await gateway.close();
    }
  });

  it("uses the idle deadline after receiving remote activity", async () => {
    const gateway = await createMockGatewayServer({
      waitPayload: { runId: "run-123", status: "timeout" },
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          waitTimeoutMs: 40,
          queueTimeoutMs: 20,
          idleTimeoutMs: 60,
          waitPollIntervalMs: 10,
        }),
      );

      expect(result).toMatchObject({
        timedOut: true,
        errorCode: "openclaw_gateway_wait_timeout",
        errorMessage: "OpenClaw gateway run produced no activity for 60ms",
        resultJson: {
          executionCancellation: { state: "acknowledged" },
          providerSettlement: { state: "terminal" },
        },
      });
      expect(gateway.getWaitRequestCount()).toBeGreaterThanOrEqual(4);
    } finally {
      await gateway.close();
    }
  });

  it("uses the cancellation handshake to stop a live remote run", async () => {
    const gateway = await createMockGatewayServer({ holdWait: true });
    const controller = new AbortController();
    let cancellationReady = false;

    try {
      const resultPromise = execute(
        buildContext(
          {
            url: gateway.url,
            disableDeviceAuth: true,
            waitTimeoutMs: 2_000,
            cancelSettlementTimeoutMs: 100,
          },
          {
            signal: controller.signal,
            onCancellationReady: async () => {
              cancellationReady = true;
            },
            onLog: async (_stream, chunk) => {
              if (chunk.includes("agent accepted")) controller.abort();
            },
          },
        ),
      );

      const result = await resultPromise;
      expect(cancellationReady).toBe(true);
      expect(result).toMatchObject({
        errorCode: "cancelled",
        resultJson: {
          executionCancellation: {
            state: "acknowledged",
            providerMethod: "sessions.abort",
          },
          providerSettlement: {
            state: "terminal",
            terminalStatus: "cancelled",
          },
        },
      });
      expect(gateway.getAbortPayload()).toEqual(
        expect.objectContaining({ runId: "run-123", clearQueued: true }),
      );
    } finally {
      await gateway.close();
    }
  });

  it("forwards gateway activity as structured adapter events", async () => {
    const gateway = await createMockGatewayServer();
    const events: Array<Record<string, unknown>> = [];

    try {
      const result = await execute(
        buildContext(
          { url: gateway.url, disableDeviceAuth: true, waitTimeoutMs: 2_000 },
          { onEvent: async (event) => events.push(event as unknown as Record<string, unknown>) },
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "openclaw.gateway.event",
            message: "OpenClaw assistant activity",
          }),
        ]),
      );
    } finally {
      await gateway.close();
    }
  });

  it("returns adapter-managed runtime services from gateway result meta", async () => {
    const gateway = await createMockGatewayServer({
      waitPayload: {
        runId: "run-123",
        status: "ok",
        startedAt: 1,
        endedAt: 2,
        meta: {
          runtimeServices: [
            {
              name: "preview",
              scopeType: "run",
              url: "https://preview.example/run-123",
              providerRef: "sandbox-123",
              lifecycle: "ephemeral",
            },
          ],
        },
      },
    });

    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          waitTimeoutMs: 2000,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.runtimeServices).toEqual([
        expect.objectContaining({
          serviceName: "preview",
          scopeType: "run",
          url: "https://preview.example/run-123",
          providerRef: "sandbox-123",
          lifecycle: "ephemeral",
          status: "running",
        }),
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("auto-approves pairing once and retries the run", async () => {
    const gateway = await createMockGatewayServerWithPairing();
    const logs: string[] = [];

    try {
      const result = await execute(
        buildContext(
          {
            url: gateway.url,
            headers: {
              "x-openclaw-token": "gateway-token",
            },
            payloadTemplate: {
              message: "wake now",
            },
            waitTimeoutMs: 2000,
          },
          {
            onLog: async (_stream, chunk) => {
              logs.push(chunk);
            },
          },
        ),
      );

      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("ok");
      expect(logs.some((entry) => entry.includes("pairing required; attempting automatic pairing approval"))).toBe(
        true,
      );
      expect(logs.some((entry) => entry.includes("auto-approved pairing request"))).toBe(true);
      expect(gateway.getAgentPayload()).toBeTruthy();
    } finally {
      await gateway.close();
    }
  });
});

describe("openclaw gateway ui build config", () => {
  it("parses payload template and runtime services json", () => {
    const config = buildOpenClawGatewayConfig({
      adapterType: "openclaw_gateway",
      cwd: "",
      promptTemplate: "",
      model: "",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "wss://gateway.example/ws",
      payloadTemplateJson: JSON.stringify({
        agentId: "remote-agent-123",
        metadata: { team: "platform" },
      }),
      runtimeServicesJson: JSON.stringify({
        services: [
          {
            name: "preview",
            lifecycle: "shared",
          },
        ],
      }),
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: true,
      intervalSec: 300,
    });

    expect(config).toEqual(
      expect.objectContaining({
        url: "wss://gateway.example/ws",
        payloadTemplate: {
          agentId: "remote-agent-123",
          metadata: { team: "platform" },
        },
        workspaceRuntime: {
          services: [
            {
              name: "preview",
              lifecycle: "shared",
            },
          ],
        },
      }),
    );
  });
});

describe("openclaw gateway testEnvironment", () => {
  it("reports missing url as failure", async () => {
    const result = await testEnvironment({
      companyId: "company-123",
      adapterType: "openclaw_gateway",
      config: {},
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "openclaw_gateway_url_missing")).toBe(true);
  });
});
