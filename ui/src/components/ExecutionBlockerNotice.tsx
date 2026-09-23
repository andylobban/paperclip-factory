import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  requiresExecutionReconciliation,
  type ExecutionBlocker,
  type ExecutionReconciliationResult,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

const MIN_EVIDENCE_LENGTH = 20;
const MAX_EVIDENCE_LENGTH = 12_000;

const outcomeOptions = [
  { value: "completed", label: "Completed" },
  { value: "not_performed", label: "Not performed" },
  { value: "mixed", label: "Mixed / partially completed" },
] as const;

function reconciliationResultCopy(result: ExecutionReconciliationResult) {
  switch (result.disposition) {
    case "verified_no_op":
      return {
        heading: "Verified: no execution was performed",
        body: "The evidence was recorded as a verified no-op: the stopped run did not perform the recorded action. The stopped run was not replayed. A new continuation may start from the reconciled state.",
      };
    case "idempotent_repeat":
      return {
        heading: "Evidence already recorded",
        body: "This matching evidence is already on record. The stopped run was not replayed and no duplicate reconciliation record was created. A new continuation may already be starting or may start from the reconciled state.",
      };
    default:
      return {
        heading: "Validated evidence recorded",
        body: "The reconciliation record was accepted. The stopped run and its action were not replayed. A new continuation may start from the reconciled state.",
      };
  }
}

function continuationDeliveryLabel(value: ExecutionReconciliationResult["continuationDelivery"]) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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
  const requiresRunInspection = blocker.cause === "native_continuation_requires_reconciliation" ||
    blocker.cause === "native_session_cleanup_quarantined";
  const [inspectOpen, setInspectOpen] = useState(false);
  const [providerStoppedConfirmed, setProviderStoppedConfirmed] = useState(false);
  const [actionOutcome, setActionOutcome] = useState<"completed" | "not_performed" | "mixed" | null>(null);
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const [validationRequested, setValidationRequested] = useState(false);
  const [result, setResult] = useState<ExecutionReconciliationResult | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
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
  const diagnosticAction = diagnostic.data?.action;
  const diagnosticMatchesBlocker = Boolean(
    diagnostic.data?.requiresExecutionReconciliation &&
    diagnosticAction &&
    diagnosticAction.id === blocker.recoveryActionId,
  );
  const reconcile = useMutation({
    mutationFn: () => {
      if (!diagnosticMatchesBlocker || !diagnosticAction || !blocker.runId ||
          !providerStoppedConfirmed || !actionOutcome) {
        throw new Error("Confirm the provider stop and record an explicit action outcome.");
      }
      return issuesApi.resolveRecoveryAction(issueId, {
        actionId: diagnosticAction.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        executionReconciliation: {
          runId: blocker.runId,
          providerStopped: true,
          actionOutcome,
          outcomeEvidence: outcomeEvidence.trim(),
        },
      }).then((response) => {
        if (!response.executionReconciliationResult) {
          throw new Error("The server did not return a reconciliation receipt.");
        }
        return response;
      });
    },
    onSuccess: (response) => {
      setResult(response.executionReconciliationResult!);
    },
  });
  const evidenceLength = outcomeEvidence.trim().length;
  const canReconcile = Boolean(
    diagnosticMatchesBlocker &&
    providerStoppedConfirmed &&
    actionOutcome &&
    evidenceLength >= MIN_EVIDENCE_LENGTH &&
    evidenceLength <= MAX_EVIDENCE_LENGTH &&
    !reconcile.isPending,
  );
  const conflict = reconcile.error instanceof ApiError && reconcile.error.status === 409;
  const reconciliationError = reconcile.isError
    ? conflict
      ? {
          heading: "Evidence conflicts with the recorded reconciliation",
          body: "The evidence was not recorded. The blocker has not changed. Review the existing record before submitting different evidence.",
        }
      : {
          heading: "Evidence was not recorded",
          body: "Evidence was not recorded. The blocker has not changed. Check the connection and try recording the same evidence again.",
        }
    : null;

  useEffect(() => {
    if (reconciliationError) errorSummaryRef.current?.focus();
  }, [reconciliationError]);

  useEffect(() => {
    if (result) resultHeadingRef.current?.focus();
  }, [result]);

  const clearSubmissionState = () => {
    if (reconcile.isError) reconcile.reset();
    setValidationRequested(false);
  };

  const submitReconciliation = () => {
    setValidationRequested(true);
    if (!canReconcile) {
      errorSummaryRef.current?.focus();
      return;
    }
    reconcile.mutate();
  };

  const copyRunId = async () => {
    if (!blocker.runId || !navigator.clipboard) return;
    await navigator.clipboard.writeText(blocker.runId);
    setCopyStatus("Stopped run ID copied.");
  };

  const handleInspectOpenChange = (open: boolean) => {
    setInspectOpen(open);
    if (!open && result) {
      onRetried();
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    }
  };

  const loadingDiagnostic = diagnostic.isPending || (diagnostic.isFetching && !diagnostic.data);
  const unavailableDiagnostic = !loadingDiagnostic &&
    (diagnostic.isError || !diagnosticMatchesBlocker);
  const resultCopy = result ? reconciliationResultCopy(result) : null;
  const runInspectionLink = blocker.agentId && blocker.runId
    ? `/agents/${blocker.agentId}/runs/${blocker.runId}`
    : null;

  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between gap-3 execution-blocker-notice border border-border bg-muted text-foreground">
      <div className="min-w-0 flex-1">
        {reconciliationRequired ? (
          <>
            <p className="font-medium">Execution stopped — reconciliation required</p>
            <p className="text-sm text-muted-foreground">The provider stopped before the outcome could be verified. This work cannot be retried or replayed. Inspect the record and enter evidence to reconcile it.</p>
          </>
        ) : (
          <span>{`${requiresRunInspection ? "Recovery needed. " : ""}${blocker.nextAction}`}</span>
        )}
      </div>
      {reconciliationRequired ? (
        <Dialog open={inspectOpen} onOpenChange={handleInspectOpenChange}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">Inspect &amp; reconcile</Button>
          </DialogTrigger>
          <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <DialogTitle>Execution stopped — reconciliation required</DialogTitle>
                <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">No replay permitted</span>
              </div>
              <DialogDescription>The provider stopped before the outcome could be verified. This work cannot be retried or replayed. Inspect the record and enter evidence to reconcile it.</DialogDescription>
            </DialogHeader>

            {loadingDiagnostic && (
              <div role="status" aria-busy="true" className="py-6 text-sm text-muted-foreground">
                Loading stopped-execution details…
              </div>
            )}

            {unavailableDiagnostic && (
              <div role="alert" className="space-y-2 rounded-md border border-border p-4">
                <h3 className="font-medium">No current reconciliation record is available</h3>
                <p className="text-sm text-muted-foreground">The current blocker does not match an active stopped-execution record. No evidence can be recorded from this view.</p>
              </div>
            )}

            {!loadingDiagnostic && !unavailableDiagnostic && result && resultCopy && (
              <div role="status" aria-live="polite" className="space-y-3 rounded-md border border-border p-4">
                <h3 ref={resultHeadingRef} tabIndex={-1} className="font-medium outline-none">{resultCopy.heading}</h3>
                <p className="text-sm text-muted-foreground">{resultCopy.body}</p>
                <dl className="grid grid-cols-(--gtc-5) gap-x-3 gap-y-1 text-sm">
                  <dt className="font-medium">Continuation status</dt>
                  <dd>{continuationDeliveryLabel(result.continuationDelivery)}</dd>
                  <dt className="font-medium">Stopped run replay</dt>
                  <dd>{result.replayStarted ? "Started" : "Not started"}</dd>
                </dl>
              </div>
            )}

            {!loadingDiagnostic && !unavailableDiagnostic && !result && (
              <form className="space-y-5" onSubmit={(event) => {
                event.preventDefault();
                submitReconciliation();
              }}>
                <section aria-label="Stopped execution record" className="space-y-3 rounded-md border border-border p-4">
                  <div className="space-y-1">
                    <Label htmlFor={`stopped-run-${issueId}`}>Stopped run ID</Label>
                    <div className="flex items-center gap-2">
                      <input id={`stopped-run-${issueId}`} readOnly value={blocker.runId ?? "Unavailable"} className="min-w-0 flex-1 rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs" />
                      {blocker.runId && <Button type="button" variant="outline" size="sm" onClick={() => void copyRunId()}>Copy</Button>}
                    </div>
                    <p aria-live="polite" className="text-xs text-muted-foreground">{copyStatus}</p>
                  </div>
                  <dl className="grid grid-cols-(--gtc-5) gap-x-3 gap-y-1 text-sm">
                    <dt className="font-medium">Current blocker</dt>
                    <dd className="break-words">{blocker.cause}</dd>
                    <dt className="font-medium">Recovery action</dt>
                    <dd className="break-all font-mono text-xs">{diagnosticAction?.id}</dd>
                  </dl>
                  <p className="text-sm text-muted-foreground">{diagnosticAction?.nextAction}</p>
                  {runInspectionLink && (
                    <Button type="button" variant="outline" size="sm" asChild>
                      <Link to={runInspectionLink}>Inspect stopped run</Link>
                    </Button>
                  )}
                </section>

                {validationRequested && !canReconcile && (
                  <div ref={errorSummaryRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm outline-none">
                    <p className="font-medium">Check the evidence before recording it.</p>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <input
                      id={`provider-stopped-${issueId}`}
                      type="checkbox"
                      checked={providerStoppedConfirmed}
                      onChange={(event) => {
                        clearSubmissionState();
                        setProviderStoppedConfirmed(event.target.checked);
                      }}
                      className="mt-1 size-4"
                    />
                    <Label htmlFor={`provider-stopped-${issueId}`}>I confirm the provider stopped this run.</Label>
                  </div>
                  <p className="text-sm text-muted-foreground">Confirming a stop does not determine whether the work completed.</p>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">What does the evidence establish?</legend>
                  {outcomeOptions.map(option => (
                    <div key={option.value} className="flex items-center gap-2">
                      <input
                        id={`action-outcome-${issueId}-${option.value}`}
                        type="radio"
                        name={`action-outcome-${issueId}`}
                        value={option.value}
                        checked={actionOutcome === option.value}
                        onChange={() => {
                          clearSubmissionState();
                          setActionOutcome(option.value);
                        }}
                        className="size-4"
                      />
                      <Label htmlFor={`action-outcome-${issueId}-${option.value}`}>{option.label}</Label>
                    </div>
                  ))}
                  <p className="text-sm text-muted-foreground">Choose only the outcome supported by the evidence. This does not retry, replay, or resume execution.</p>
                </fieldset>

                <div className="space-y-2">
                  <Label htmlFor={`outcome-evidence-${issueId}`}>Evidence for the outcome</Label>
                  <p id={`outcome-evidence-help-${issueId}`} className="text-sm text-muted-foreground">Describe the provider-stop verification and the records that establish whether the action completed. Enter between 20 and 12,000 characters.</p>
                  <Textarea
                    id={`outcome-evidence-${issueId}`}
                    aria-describedby={`outcome-evidence-help-${issueId} outcome-evidence-count-${issueId}`}
                    value={outcomeEvidence}
                    maxLength={MAX_EVIDENCE_LENGTH}
                    onChange={(event) => {
                      clearSubmissionState();
                      setOutcomeEvidence(event.target.value);
                    }}
                    placeholder="Describe the provider-stop verification and evidence for the action outcome."
                    rows={6}
                  />
                  <p id={`outcome-evidence-count-${issueId}`} aria-live="polite" className="text-xs text-muted-foreground">{outcomeEvidence.length.toLocaleString()} / 12,000 characters</p>
                </div>

                {reconciliationError && (
                  <div ref={errorSummaryRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm outline-none">
                    <p className="font-medium">{reconciliationError.heading}</p>
                    <p>{reconciliationError.body}</p>
                  </div>
                )}

                <DialogFooter>
                  <DialogClose asChild><Button type="button" variant="outline">Close</Button></DialogClose>
                  <Button type="submit" disabled={!canReconcile}>{reconcile.isPending ? "Recording…" : "Record validated evidence"}</Button>
                </DialogFooter>
              </form>
            )}

            {!loadingDiagnostic && !unavailableDiagnostic && result && (
              <DialogFooter><DialogClose asChild><Button type="button">Close</Button></DialogClose></DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      ) : requiresRunInspection && runInspectionLink ? (
        <Button variant="outline" size="sm" asChild>
          <Link to={runInspectionLink}>Inspect run</Link>
        </Button>
      ) : failedRun ? (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
    </div>
  );
}
