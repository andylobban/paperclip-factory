import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const requiresReconciliation = blocker.cause === "legacy_execution_requires_reconciliation";
  const [inspectOpen, setInspectOpen] = useState(false);
  const [actionOutcome, setActionOutcome] = useState<"completed" | "not_performed" | "mixed">("not_performed");
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const diagnostic = useQuery({
    queryKey: ["recovery-action-diagnostic", issueId],
    queryFn: () => issuesApi.getRecoveryActionDiagnostic(issueId),
    enabled: requiresReconciliation && inspectOpen,
  });
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
    onSuccess: () => {
      onRetried();
      for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
        queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
  const reconcile = useMutation({
    mutationFn: () => {
      const action = diagnostic.data?.action;
      if (!action || !blocker.runId) throw new Error("The stopped execution record is no longer available.");
      return issuesApi.resolveRecoveryAction(issueId, {
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        executionReconciliation: {
          runId: blocker.runId,
          providerStopped: true,
          actionOutcome,
          outcomeEvidence,
        },
      });
    },
    onSuccess: () => {
      setInspectOpen(false);
      onRetried();
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    },
  });
  const canReconcile = Boolean(diagnostic.data?.requiresExecutionReconciliation && outcomeEvidence.trim().length >= 20 && !reconcile.isPending);
  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <span>{blocker.cause === "legacy_execution_requires_reconciliation" ? "Automatic recovery of this task stopped." : blocker.nextAction}</span>
      {requiresReconciliation ? (
        <Button variant="outline" size="sm" disabled={diagnostic.isFetching} onClick={() => setInspectOpen(true)}>
          {diagnostic.isFetching ? "Inspecting…" : "Inspect & reconcile"}
        </Button>
      ) : failedRun && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
      {inspectOpen && (
        <div className="mt-3 w-full space-y-2 border-t border-border pt-3">
          <p className="text-sm">{diagnostic.data?.action?.nextAction ?? "Loading the held recovery record…"}</p>
          <label className="block text-sm font-medium">Recorded action outcome
            <select value={actionOutcome} onChange={(event) => setActionOutcome(event.target.value as typeof actionOutcome)} className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="not_performed">Not performed</option><option value="completed">Completed</option><option value="mixed">Mixed</option>
            </select>
          </label>
          <Textarea value={outcomeEvidence} onChange={(event) => setOutcomeEvidence(event.target.value)} placeholder="Describe the provider-stop verification and evidence for the action outcome." />
          <Button size="sm" disabled={!canReconcile} onClick={() => reconcile.mutate()}>Record evidence and continue</Button>
          {reconcile.isError && <p role="alert" className="text-destructive">{reconcile.error.message}</p>}
        </div>
      )}
    </div>
  );
}
