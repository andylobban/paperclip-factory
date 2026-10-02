import type { IssuePipelineCaseLink } from "@/api/issues";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { ArrowRight, GitBranch } from "lucide-react";

export function IssuePipelineChain({
  linkedCases,
}: {
  linkedCases: IssuePipelineCaseLink[];
}) {
  if (linkedCases.length === 0) return null;

  return (
    <section
      data-testid="issue-pipeline-chain"
      aria-label="Pipeline work chain"
      className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" aria-hidden />
        Pipeline work chain
      </div>
      {linkedCases.map((linkedCase) => (
        <div key={linkedCase.id} className="space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Link
              to={`/pipelines/${linkedCase.pipeline.id}/items/${linkedCase.id}`}
              className="min-w-0 font-medium hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {linkedCase.caseKey}
              </span>{" "}
              <span>{linkedCase.title}</span>
            </Link>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <Badge variant="secondary" className="text-(length:--text-nano)">
              {linkedCase.stage.name}
            </Badge>
          </div>
          <ol className="flex flex-wrap items-center gap-1.5">
            {linkedCase.issues.map((chainIssue, index) => (
              <li key={chainIssue.id} className="flex items-center gap-1.5">
                {index > 0 ? (
                  <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />
                ) : null}
                <div
                  className={
                    chainIssue.current
                      ? "flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-2 py-1"
                      : "flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1"
                  }
                >
                  {chainIssue.current ? (
                    <span className="max-w-48 truncate text-xs font-medium" title={chainIssue.title}>
                      {chainIssue.identifier ?? chainIssue.title}
                    </span>
                  ) : (
                    <Link
                      to={`/issues/${chainIssue.identifier ?? chainIssue.id}`}
                      className="max-w-48 truncate text-xs font-medium hover:underline"
                      title={chainIssue.title}
                    >
                      {chainIssue.identifier ?? chainIssue.title}
                    </Link>
                  )}
                  <span className="text-(length:--text-nano) text-muted-foreground">
                    {chainIssue.role.replace(/_/g, " ")}
                  </span>
                  <StatusBadge status={chainIssue.status} />
                  {chainIssue.retiredAt ? (
                    <span className="text-(length:--text-nano) text-muted-foreground">retired</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
