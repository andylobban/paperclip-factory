import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  defaultMaxConcurrentRunsForAdapter,
} from "./constants.js";

describe("defaultMaxConcurrentRunsForAdapter", () => {
  it("serializes OpenClaw gateways by default", () => {
    expect(defaultMaxConcurrentRunsForAdapter("openclaw_gateway")).toBe(1);
  });

  it("preserves the general scheduler default for other adapters", () => {
    expect(defaultMaxConcurrentRunsForAdapter("codex_local")).toBe(
      AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
    );
    expect(defaultMaxConcurrentRunsForAdapter(undefined)).toBe(
      AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
    );
  });
});
