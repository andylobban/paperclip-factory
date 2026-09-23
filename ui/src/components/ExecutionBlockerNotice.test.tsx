// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { getRecoveryActionDiagnostic: vi.fn(), resolveRecoveryAction: vi.fn() } }));

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    vi.mocked(issuesApi.getRecoveryActionDiagnostic).mockResolvedValue({ requiresExecutionReconciliation: true, action: {
      id: "recovery", nextAction: "Verify provider shutdown and record the observed action outcome.",
    } } as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  it("shows an inspect-and-reconcile action instead of blind Retry", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toContain("Automatic recovery of this task stopped.");
    expect(notice.textContent).toContain("Inspect & reconcile");
    expect(notice.textContent).not.toContain("Retry");
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
    expect(notice.querySelector("a")).toBeNull();
  });
  it("explains that reconciliation did not replay the stopped action and a fresh continuation may start", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toContain("The stopped run was not replayed.");
    expect(notice.textContent).toContain("A fresh continuation may start after reconciliation.");
    expect(notice.textContent).not.toContain("No future provider execution can occur.");
  });
  it("keeps the required next action for other reconciliation causes", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "ordinary_provider_failure",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Verify the external action outcome before continuing.");
    expect(container.textContent).not.toContain("Automatic recovery of this task stopped.");
  });
  it("requires explicit stop and outcome evidence before reconciling", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const submit = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Record evidence and continue")!;
    expect(submit().disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
    const textArea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textArea, "Provider process is absent and audit records show no action was submitted.",
      );
      textArea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalled();
  });
  it("shows a failed Retry for non-reconciliation blockers and allows another attempt", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "ordinary_provider_failure",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
});
