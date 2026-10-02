// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";

vi.mock("@/lib/router", () => ({
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));

import { IssuePipelineChain } from "./IssuePipelineChain";

describe("IssuePipelineChain", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  it("shows the case and complete linked issue chain", () => {
    const root = createRoot(container);
    flushSync(() => root.render(<IssuePipelineChain linkedCases={[{
      id: "case-1",
      caseKey: "issue:AND-697",
      title: "Ship the pipeline change",
      status: "open",
      role: "work",
      pipeline: { id: "pipeline-1", key: "delivery", name: "Delivery" },
      stage: { id: "stage-2", key: "design", name: "Design", kind: "working" },
      issues: [
        { id: "issue-697", identifier: "AND-697", title: "Origin", status: "in_progress", role: "origin", retiredAt: null, current: false },
        { id: "issue-698", identifier: "AND-698", title: "Product", status: "done", role: "automation", retiredAt: null, current: true },
        { id: "issue-699", identifier: "AND-699", title: "Engineering", status: "done", role: "automation", retiredAt: "2026-10-02T00:00:00.000Z", current: false },
      ],
    }]} />));

    expect(container.textContent).toContain("Pipeline work chain");
    expect(container.textContent).toContain("issue:AND-697 Ship the pipeline change");
    expect(container.textContent).toContain("AND-697");
    expect(container.textContent).toContain("AND-698");
    expect(container.textContent).toContain("AND-699");
    expect(container.textContent).toContain("retired");
    expect(container.querySelector('a[href="/pipelines/pipeline-1/items/case-1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/AND-697"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/AND-699"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/AND-698"]')).toBeNull();
    flushSync(() => root.unmount());
  });

  it("renders nothing when the issue is not linked to a case", () => {
    const root = createRoot(container);
    flushSync(() => root.render(<IssuePipelineChain linkedCases={[]} />));
    expect(container.innerHTML).toBe("");
    flushSync(() => root.unmount());
  });
});
