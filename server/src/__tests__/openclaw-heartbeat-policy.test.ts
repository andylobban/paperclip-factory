import { describe, expect, it } from "vitest";
import { agents } from "@paperclipai/db";
import { parseHeartbeatPolicy } from "../services/heartbeat.ts";

function openClawAgent(runtimeConfig: Record<string, unknown>): typeof agents.$inferSelect {
  return {
    adapterType: "openclaw_gateway",
    runtimeConfig,
  } as typeof agents.$inferSelect;
}

describe("OpenClaw heartbeat policy", () => {
  it("defaults missing OpenClaw concurrency to one at runtime", () => {
    expect(parseHeartbeatPolicy(openClawAgent({})).maxConcurrentRuns).toBe(1);
  });

  it("preserves explicit OpenClaw concurrency at runtime", () => {
    expect(
      parseHeartbeatPolicy(
        openClawAgent({ heartbeat: { maxConcurrentRuns: 4 } }),
      ).maxConcurrentRuns,
    ).toBe(4);
  });
});
