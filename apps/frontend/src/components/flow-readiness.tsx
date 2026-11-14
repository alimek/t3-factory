import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, CircleDot } from "lucide-react";
import type { FlowGraph, FlowReadiness, ValidationIssue } from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The block an issue path refers to: null clears the selection, undefined leaves it. */
function issueSelection(path: string, graph: FlowGraph): string | null | undefined {
  const block = /^graph\.blocks\.(\d+)/.exec(path)?.[1];
  if (block) return graph.blocks[Number(block)]?.id ?? null;
  const connection = /^graph\.connections\.(\d+)/.exec(path)?.[1];
  if (connection) return graph.connections[Number(connection)]?.sourceBlockId ?? null;
  if (!path.startsWith("graph.flowInput")) return undefined;
  const target = /^graph\.flowInput\.targetBlockIds\.(\d+)/.exec(path)?.[1];
  const id = target === undefined ? undefined : graph.flowInput.targetBlockIds[Number(target)];
  return graph.blocks.find((b) => b.id === id)?.id ?? null;
}

/**
 * Validation issue paths such as `graph.blocks.2.name` select the block they refer to and a
 * connection path its source block; a Flow input target path selects that target, and other
 * Flow input issues clear the selection.
 */
export function IssueLink({
  issue,
  graph,
  onSelect,
  children,
}: {
  issue: ValidationIssue;
  graph: FlowGraph;
  onSelect: (blockId: string | null) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="block rounded-sm text-left text-xs text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={() => {
        const selection = issueSelection(issue.path, graph);
        if (selection !== undefined) onSelect(selection);
      }}
    >
      {children}
    </button>
  );
}

/**
 * The readiness label: a backend check result, or a prompt to check the changed draft or, after
 * an Agent it places changed, to check it again.
 */
function readinessSummary(readiness: FlowReadiness | null, agentsChanged: boolean) {
  if (!readiness)
    return {
      label: agentsChanged
        ? "Agents changed — check readiness again"
        : "Draft changed · Check readiness",
      Icon: CircleDot,
      tone: "text-muted-foreground",
    };
  return readiness.ready
    ? { label: "Graph ready", Icon: Check, tone: "text-success" }
    : { label: "Not execution-ready", Icon: CircleAlert, tone: "text-attention" };
}

/** Readiness summary floating at the canvas's top left; its issue list expands on demand. */
export function ReadinessPanel({
  readiness,
  agentsChanged,
  graph,
  onSelect,
}: {
  readiness: FlowReadiness | null;
  agentsChanged: boolean;
  graph: FlowGraph;
  onSelect: (blockId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const issues = readiness?.issues.length ?? 0;
  // A check that finds problems lists them; a ready or stale result stays compact.
  useEffect(() => {
    if (issues > 0) setOpen(true);
  }, [readiness, issues]);
  const summary = readinessSummary(readiness, agentsChanged);
  return (
    <div className="absolute top-4 left-4 z-[5] grid max-w-80 gap-2">
      <Button
        variant="outline"
        size="sm"
        className="w-fit bg-card shadow-floating"
        aria-expanded={open}
        aria-controls="flow-readiness"
        onClick={() => setOpen(!open)}
      >
        <summary.Icon aria-hidden className={summary.tone} />
        <span>{summary.label}</span>
        {issues > 0 && (
          <span className="text-muted-foreground">
            · {issues} {issues === 1 ? "issue" : "issues"}
          </span>
        )}
        <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div
          id="flow-readiness"
          className="grid gap-2 rounded-lg border bg-card p-3 shadow-floating"
        >
          {readiness?.issues.map((issue, i) => (
            <IssueLink key={i} issue={issue} graph={graph} onSelect={onSelect}>
              {issue.message}
            </IssueLink>
          ))}
          {readiness?.ready && (
            <p className="text-xs text-muted-foreground">
              Graph requirements are met. Connection, Agent settings, project and runtime checks are
              separate launch gates.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Incomplete drafts can be saved. Unconnected exits finish that branch.
          </p>
        </div>
      )}
    </div>
  );
}
