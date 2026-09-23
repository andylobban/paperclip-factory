// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";

vi.mock("../lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { getRecoveryActionDiagnostic: vi.fn(), resolveRecoveryAction: vi.fn() } }));

const reconciliationBlocker = {
  recoveryActionId: "recovery",
  runId: "failed-run",
  agentId: "agent",
  cause: "legacy_execution_requires_reconciliation",
  nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
};

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();

  const flush = async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  };

  const button = (name: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find(candidate => candidate.textContent === name)!;

  const renderNotice = async (blocker = reconciliationBlocker) => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <ExecutionBlockerNotice
          companyId="company"
          issueId="task"
          onRetried={onRetried}
          blocker={blocker}
        />
      </QueryClientProvider>,
    ));
    await flush();
  };

  const openReconciliation = async () => {
    await act(async () => button("Inspect & reconcile").click());
    await flush();
  };

  const setTextAreaValue = async (value: string) => {
    const textArea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textArea, value);
      textArea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const fillValidEvidence = async (evidence = "Provider process is absent and the audit log proves the action completed.") => {
    await act(async () => document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => document.body.querySelector<HTMLInputElement>('input[type="radio"][value="completed"]')!.click());
    await setTextAreaValue(evidence);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    vi.mocked(issuesApi.getRecoveryActionDiagnostic).mockResolvedValue({
      requiresExecutionReconciliation: true,
      action: { id: "recovery", nextAction: "Verify provider shutdown and record the observed action outcome." },
    } as never);
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({
      issue: {},
      recoveryAction: {},
      executionReconciliationResult: {
        disposition: "accepted",
        actionOutcome: "completed",
        continuationDelivery: "pending",
        replayStarted: false,
      },
    } as never);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    document.body.innerHTML = "";
  });

  it("offers inspection without a blind retry or a replay claim", async () => {
    await renderNotice();
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toContain("Execution stopped — reconciliation required");
    expect(notice.textContent).toContain("This work cannot be retried or replayed.");
    expect(notice.textContent).toContain("Inspect & reconcile");
    expect(Array.from(notice.querySelectorAll("button")).some(candidate => candidate.textContent === "Retry")).toBe(false);
  });

  it("withholds the form while the stopped-execution details load", async () => {
    vi.mocked(issuesApi.getRecoveryActionDiagnostic).mockReturnValue(new Promise(() => {}) as never);
    await renderNotice();
    await act(async () => button("Inspect & reconcile").click());
    expect(document.body.textContent).toContain("Loading stopped-execution details…");
    expect(document.body.querySelector("form")).toBeNull();
    expect(document.body.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("shows an unavailable state when the current blocker has no matching action", async () => {
    vi.mocked(issuesApi.getRecoveryActionDiagnostic).mockResolvedValue({
      requiresExecutionReconciliation: true,
      action: { id: "different-action" },
    } as never);
    await renderNotice();
    await openReconciliation();
    expect(document.body.textContent).toContain("No current reconciliation record is available");
    expect(document.body.querySelector("form")).toBeNull();
  });

  it("requires explicit stop, outcome, and bounded evidence before submission", async () => {
    await renderNotice();
    await openReconciliation();
    expect(button("Record validated evidence").disabled).toBe(true);
    await fillValidEvidence();
    const textArea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textArea.maxLength).toBe(12_000);
    expect(document.body.textContent).toContain("73 / 12,000 characters");
    expect(button("Record validated evidence").disabled).toBe(false);
    await act(async () => button("Record validated evidence").click());
    await flush();
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", expect.objectContaining({
      actionId: "recovery",
      executionReconciliation: {
        runId: "failed-run",
        providerStopped: true,
        actionOutcome: "completed",
        outcomeEvidence: "Provider process is absent and the audit log proves the action completed.",
      },
    }));
  });

  it.each([
    ["accepted", "Validated evidence recorded", "The reconciliation record was accepted."],
    ["verified_no_op", "Verified: no execution was performed", "verified no-op"],
    ["idempotent_repeat", "Evidence already recorded", "no duplicate reconciliation record was created"],
  ] as const)("renders the typed %s receipt without implying stopped-run replay", async (disposition, heading, copy) => {
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({
      issue: {},
      recoveryAction: {},
      executionReconciliationResult: {
        disposition,
        actionOutcome: disposition === "verified_no_op" ? "not_performed" : "completed",
        continuationDelivery: "delegated",
        replayStarted: false,
      },
    } as never);
    await renderNotice();
    await openReconciliation();
    await fillValidEvidence();
    await act(async () => button("Record validated evidence").click());
    await flush();
    expect(document.body.textContent).toContain(heading);
    expect(document.body.textContent).toContain(copy);
    expect(document.body.textContent).toContain("A new continuation");
    expect(document.body.textContent).toContain("Stopped run replayNot started");
    expect(document.activeElement?.textContent).toBe(heading);
    expect(onRetried).not.toHaveBeenCalled();
    await act(async () => button("Close").click());
    await flush();
    expect(onRetried).toHaveBeenCalledOnce();
  });

  it("keeps entered evidence and the blocker unchanged on a 409 conflict", async () => {
    vi.mocked(issuesApi.resolveRecoveryAction).mockRejectedValue(new ApiError("Conflict", 409, { error: "Conflict" }));
    await renderNotice();
    await openReconciliation();
    const evidence = "Audit records differ from the reconciliation evidence already stored.";
    await fillValidEvidence(evidence);
    await act(async () => button("Record validated evidence").click());
    await flush();
    expect(document.body.textContent).toContain("Evidence conflicts with the recorded reconciliation");
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(evidence);
    expect(onRetried).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
  });

  it("keeps entered evidence on a network failure so the same submission can be retried", async () => {
    vi.mocked(issuesApi.resolveRecoveryAction).mockRejectedValue(new Error("Network unavailable"));
    await renderNotice();
    await openReconciliation();
    const evidence = "Provider is stopped and the durable audit record confirms no side effect.";
    await fillValidEvidence(evidence);
    await act(async () => button("Record validated evidence").click());
    await flush();
    expect(document.body.textContent).toContain("Check the connection and try recording the same evidence again.");
    expect(document.body.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(evidence);
    expect(onRetried).not.toHaveBeenCalled();
  });

  it("retains source-run inspection in the reconciliation flow", async () => {
    await renderNotice({
      ...reconciliationBlocker,
      cause: "native_continuation_requires_reconciliation",
    });
    await openReconciliation();
    const link = Array.from(document.body.querySelectorAll("a"))
      .find(candidate => candidate.textContent === "Inspect stopped run")!;
    expect(link.getAttribute("href")).toBe("/agents/agent/runs/failed-run");
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger when the reconciliation dialog closes", async () => {
    await renderNotice();
    const trigger = button("Inspect & reconcile");
    await openReconciliation();
    await act(async () => button("Close").click());
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps ordinary non-reconciliation retry behavior", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await renderNotice({
      ...reconciliationBlocker,
      cause: "ordinary_provider_failure",
      nextAction: "Verify the external action outcome before continuing.",
    });
    await act(async () => button("Retry").click());
    await flush();
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(button("Retry").disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
});
