import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  requiresExecutionReconciliation,
  type ExecutionBlocker,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
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
  const reconciliationRequired = requiresExecutionReconciliation(blocker.cause);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [providerStoppedConfirmed, setProviderStoppedConfirmed] = useState(false);
  const [actionOutcome, setActionOutcome] = useState<"completed" | "not_performed" | "mixed" | null>(null);
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const diagnostic = useQuery({
    queryKey: ["recovery-action-diagnostic", issueId],
    queryFn: () => issuesApi.getRecoveryActionDiagnostic(issueId),
    enabled: reconciliationRequired && inspectOpen,
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
      if (!action || !blocker.runId || !providerStoppedConfirmed || !actionOutcome) {
        throw new Error("Confirm the provider stop and record an explicit action outcome.");
      }
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
  const canReconcile = Boolean(
    diagnostic.data?.requiresExecutionReconciliation &&
    providerStoppedConfirmed &&
    actionOutcome &&
    outcomeEvidence.trim().length >= 20 &&
    !reconcile.isPending,
  );
  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <span>{reconciliationRequired
        ? "Automatic recovery of this task stopped. The stopped run was not replayed. A fresh continuation may start after reconciliation."
        : blocker.nextAction}</span>
      {reconciliationRequired ? (
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
          <div className="flex items-center gap-2">
            <Checkbox
              id={`provider-stopped-${issueId}`}
              checked={providerStoppedConfirmed}
              onCheckedChange={(checked) => setProviderStoppedConfirmed(checked === true)}
            />
            <Label htmlFor={`provider-stopped-${issueId}`}>I verified that the provider process has stopped</Label>
          </div>
          <Label htmlFor={`action-outcome-${issueId}`}>Recorded action outcome</Label>
          <Select value={actionOutcome ?? undefined} onValueChange={(value) => setActionOutcome(value as Exclude<typeof actionOutcome, null>)}>
            <SelectTrigger id={`action-outcome-${issueId}`} className="w-full">
              <SelectValue placeholder="Select the observed outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="not_performed">Not performed</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="mixed">Mixed</SelectItem>
            </SelectContent>
          </Select>
          <Textarea value={outcomeEvidence} onChange={(event) => setOutcomeEvidence(event.target.value)} placeholder="Describe the provider-stop verification and evidence for the action outcome." />
          <Button size="sm" disabled={!canReconcile} onClick={() => reconcile.mutate()}>Record evidence and continue</Button>
          {reconcile.isError && <p role="alert" className="text-destructive">{reconcile.error.message}</p>}
        </div>
      )}
    </div>
  );
}
