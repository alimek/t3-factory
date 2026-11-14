import { useState } from "react";
import type {
  FactoryProject,
  FlowBlock,
  RunBlock,
  RunDetail,
  RunTitleGeneration,
} from "@t3-factory/contracts";
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleStop,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { capturedExits } from "../flow-graph.ts";
import { blockVisits } from "./execution-canvas.tsx";
import { clockTime, executionStateLabel, StatePill } from "./execution-state.tsx";
import { exitDisplayName } from "./flow-block.tsx";
import { PanelResizeHandle, type PanelBounds } from "./panel-resize.tsx";
import { RunAttentionDetails } from "./run-attention.tsx";
import { RootWork } from "./run-coordination-controls.tsx";
import { BindingLink, bindingRole, CoordinatorActivations } from "./run-coordination.tsx";
import { RunInitialPrompt } from "./run-prompt.tsx";
import { repositorySummary, RunRepositories } from "./run-repositories.tsx";
import { InspectorDisclosure, InspectorSection } from "./inspector-section.tsx";
import { activeStates, currentVisitText, RunBlockView } from "./run-block-view.tsx";
import { RunTitleView } from "./run-title-view.tsx";

/** Keeps the width users chose for the earlier Run side panels. */
const inspectorBounds: PanelBounds = {
  variable: "--factory-run-panel-width",
  storageKey: "factory.runSidePanelWidth",
  min: 280,
  max: 640,
};

const secondaryTextClass = "text-xs text-muted-foreground";

const stateIcon: Record<RunBlock["state"], { Icon: LucideIcon; className: string } | undefined> = {
  "not-started": undefined,
  working: { Icon: LoaderCircle, className: "text-status-working motion-safe:animate-spin" },
  waiting: { Icon: CirclePause, className: "text-status-waiting" },
  sent: { Icon: LoaderCircle, className: "text-link motion-safe:animate-spin" },
  finished: { Icon: CircleCheck, className: "text-success" },
  "pass-through": { Icon: CircleCheck, className: "text-success" },
  error: { Icon: CircleAlert, className: "text-destructive" },
  stopped: { Icon: CircleStop, className: "text-status-stopped" },
};

/** An active block's current visit; a settled one's exit and when it was accepted. */
function progressLine(run: RunDetail, block: FlowBlock, recorded: RunBlock) {
  if (activeStates.includes(recorded.state))
    return currentVisitText(run, block, blockVisits(run, block));
  const report = run.reports.findLast(
    (item) => item.blockId === block.id && item.status === "finished",
  );
  const exit = capturedExits(run.definitions, block.id).find((item) => item.id === report?.exitId);
  if (recorded.state === "finished" && report && exit)
    return `${exitDisplayName(exit, "Output")} · ${clockTime(report.acceptedAt)}`;
  return executionStateLabel(recorded.state);
}

/** Figma RD13 Progress: started blocks in Flow order; the canvas still shows the whole graph. */
function RunProgress({ run }: { run: RunDetail }) {
  const blocks = run.definitions.flow.graph.blocks;
  const started = blocks.flatMap((block) => {
    const recorded = run.blocks.find((item) => item.blockId === block.id);
    return recorded && recorded.state !== "not-started" ? [{ block, recorded }] : [];
  });
  if (!started.length) return null;
  return (
    <InspectorSection title={`Progress · ${started.length} of ${blocks.length}`} label="Progress">
      <ul className="flex flex-col gap-2.5">
        {started.map(({ block, recorded }) => {
          const icon = stateIcon[recorded.state];
          return (
            <li
              key={block.id}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5",
                recorded.state === "working" && "bg-muted",
              )}
            >
              {icon && (
                <icon.Icon
                  aria-hidden
                  strokeWidth={1.75}
                  className={cn("size-3.5 shrink-0", icon.className)}
                />
              )}
              <span className="sr-only">{executionStateLabel(recorded.state)}:</span>
              <span className="min-w-0 shrink truncate text-sm font-medium text-foreground">
                {block.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-right text-label text-subtle-foreground">
                {progressLine(run, block, recorded)}
              </span>
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
}

function repositoriesTitle(run: RunDetail) {
  const { branches, pullRequests } = repositorySummary(run.repositories);
  const title = [
    branches.length && (branches.length > 1 ? "branches" : "branch"),
    pullRequests.length && (pullRequests.length > 1 ? "pull requests" : "pull request"),
  ]
    .filter(Boolean)
    .join(" & ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

const longPrompt = (input: string) => input.length > 180 || input.split("\n").length > 3;

/** A long text prompt starts as a preview; prompts with images keep their references in view. */
function InitialPrompt({ run }: { run: RunDetail }) {
  const collapsible = !run.images.length && longPrompt(run.input);
  const [full, setFull] = useState(false);
  return (
    <InspectorSection title="Initial prompt" label="Run input">
      <RunInitialPrompt run={run} preview={collapsible && !full} />
      {collapsible && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="w-fit text-label"
          aria-expanded={full}
          onClick={() => setFull(!full)}
        >
          {full ? "Show less" : "Show full prompt"}
        </Button>
      )}
    </InspectorSection>
  );
}

const worktreeNote = {
  preparing: ". Other workers join it once T3 reports its path and branch.",
  bound: ", shared by every worker of this Run.",
  failed: ". No worker falls back to the project checkout.",
};

/** The workspace every worker of the Run shares, as T3 reported it. */
function RunWorkspace({ run }: { run: RunDetail }) {
  const { workspace } = run;
  if (workspace.mode === "checkout")
    return (
      <InspectorSection title="Workspace" label="Run workspace">
        <p className="text-sm text-emphasis-foreground">Project checkout</p>
      </InspectorSection>
    );
  return (
    <InspectorSection title="Workspace" label="Run workspace">
      {workspace.state === "bound" && (
        <p className="flex min-w-0 items-start gap-1.5 text-sm text-emphasis-foreground">
          <GitBranch aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 break-all">
            Worktree · <span className="font-mono text-xs">{workspace.branch}</span> ·{" "}
            <span className="font-mono text-xs">{workspace.path}</span>
          </span>
        </p>
      )}
      {workspace.state === "preparing" && (
        <p className="text-sm text-emphasis-foreground">Preparing workspace</p>
      )}
      {workspace.state === "failed" && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          Workspace failed
        </p>
      )}
      <p className={secondaryTextClass}>
        New worktree from {workspace.baseRef}
        {worktreeNote[workspace.state]}
      </p>
      {workspace.problem && (
        <p
          role="status"
          className={cn(
            "rounded-md border p-3 text-xs text-emphasis-foreground",
            workspace.state === "failed"
              ? "border-destructive/40 bg-destructive/8"
              : "border-attention/40 bg-attention/8",
          )}
        >
          {workspace.problem}
        </p>
      )}
    </InspectorSection>
  );
}

function PendingIntents({ run }: { run: RunDetail }) {
  const intents = run.intents.filter(
    (intent) => intent.state !== "acknowledged" && intent.state !== "cancelled",
  );
  if (!intents.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {intents.map((intent) => (
        <p
          role="status"
          key={intent.id}
          className="rounded-md border border-attention/40 bg-attention/8 p-3 text-xs text-emphasis-foreground"
        >
          {intent.state === "pending" ? `${intent.kind} pending` : `Uncertain ${intent.kind}`}:{" "}
          {intent.kind === "handoff" && intent.state === "pending"
            ? (intent.problem ?? "Handoff held; delivery has not started.")
            : (intent.problem ?? "Awaiting the exact T3 reference.")}
        </p>
      ))}
    </div>
  );
}

function elapsedSeconds(from: string, to: string) {
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000).toFixed(1);
}

function observedTime(at: string | null | undefined) {
  return at ? new Date(at).toLocaleString() : "not yet observed";
}

function WorkPeriods({ run }: { run: RunDetail }) {
  if (!run.executions.length) return null;
  return (
    <InspectorSection title="Work periods" label="Work periods">
      {run.executions.map((execution) => {
        const block = run.blocks.find((item) => item.blockId === execution.blockId);
        const binding = run.threadBindings.find((item) => item.id === execution.bindingId);
        return (
          <article
            className="flex flex-col gap-1 rounded-md border bg-muted p-3 text-xs text-muted-foreground"
            key={`${execution.bindingId}/${execution.executionId}`}
            aria-label={`${binding ? bindingRole[binding.role] : "Agent"} · ${execution.executionId}`}
          >
            <h4 className="text-sm font-medium break-all text-foreground">
              {block?.name ?? execution.blockId} ·{" "}
              {binding ? `${bindingRole[binding.role]} · ` : ""}
              {execution.executionId}
            </h4>
            <p className="flex flex-wrap items-center gap-1">
              T3 execution: <StatePill state={execution.engineStatus ?? "unknown"} /> · Report:{" "}
              {execution.reportStatus
                ? `accepted ${execution.reportStatus}`
                : binding?.role === "descendant"
                  ? "the worker reports the result"
                  : "not reported"}
            </p>
            {execution.problem && <p>Recorded Problem: {execution.problem}</p>}
            {run.recoveries
              .filter(
                (r) => r.blockId === execution.blockId && r.executionId === execution.executionId,
              )
              .map((r) => (
                <p key={r.attentionId}>
                  Manual report recovery for {r.sourceExecutionId} ·{" "}
                  {r.settledAt ? "reporting obligation settled" : "unresolved"}
                </p>
              ))}
            <p>
              Observed start: {observedTime(execution.observedStartedAt)} · Observed end:{" "}
              {observedTime(execution.observedEndedAt)}
            </p>
            {execution.observedStartedAt && execution.observedEndedAt && (
              <p>
                Approximate elapsed:{" "}
                {elapsedSeconds(execution.observedStartedAt, execution.observedEndedAt)} s
              </p>
            )}
            {binding ? (
              <>
                <p className="break-all">Thread: {binding.threadId}</p>
                <BindingLink binding={binding} />
              </>
            ) : (
              block?.link && (
                <a
                  className="w-fit text-link hover:underline"
                  href={block.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in T3
                </a>
              )
            )}
          </article>
        );
      })}
    </InspectorSection>
  );
}

/** Figma RD13: Run-level facts with one home; raw ids, workspace and periods stay folded. */
function RunOverview({
  run,
  project,
  projectUnavailable,
  observationUnavailable,
}: {
  run: RunDetail;
  project: FactoryProject | undefined;
  projectUnavailable: boolean;
  observationUnavailable: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5.5 overflow-auto px-4 pt-4 pb-3">
      <header className="flex flex-col gap-0.75">
        <h2 className="text-base leading-4 font-semibold">Overview</h2>
        <p className="text-label leading-3.5 text-subtle-foreground">
          Select a block on the canvas to see its details here.
        </p>
      </header>
      <RunAttentionDetails run={run} observationUnavailable={observationUnavailable} />
      <PendingIntents run={run} />
      <RunProgress run={run} />
      {run.repositories.some((worker) => worker.branch || worker.pullRequests.length > 0) && (
        <InspectorSection title={repositoriesTitle(run)} label="Run repositories">
          <RunRepositories workers={run.repositories} links />
        </InspectorSection>
      )}
      <InitialPrompt run={run} />
      <CoordinatorActivations run={run} />
      <RootWork run={run} />
      <div aria-hidden className="flex-1" />
      <InspectorDisclosure label="Workspace & observation" hint="worktree · ids · freshness">
        <InspectorSection title="Project">
          <p className="text-sm text-emphasis-foreground">
            {project?.title ?? "Project"}
            {projectUnavailable ? " · unavailable in T3" : ""}
          </p>
        </InspectorSection>
        <InspectorSection title="Flow revision">
          <p className="text-sm text-emphasis-foreground">
            {run.definitions.flow.name} · revision {run.definitions.flow.revision}
          </p>
        </InspectorSection>
        <RunWorkspace run={run} />
        <WorkPeriods run={run} />
      </InspectorDisclosure>
    </div>
  );
}

/**
 * The one docked inspector beside the Execution canvas: the Run overview, the selected block or
 * the Run title. What is inspected is the caller's; whether the inspector is shown is the
 * viewer's preference.
 */
export function RunInspector({
  run,
  selected,
  titleGeneration,
  project,
  projectUnavailable,
  observationUnavailable,
  onSelect,
}: {
  run: RunDetail;
  selected: string | null;
  /** The Run title's generation while the Run title is inspected. */
  titleGeneration: RunTitleGeneration | null;
  project: FactoryProject | undefined;
  projectUnavailable: boolean;
  observationUnavailable: boolean;
  onSelect: (blockId: string | null) => void;
}) {
  const block = run.definitions.flow.graph.blocks.find((item) => item.id === selected);
  const recorded = run.blocks.find((item) => item.blockId === selected);
  return (
    <aside
      aria-label="Run inspector"
      className="relative flex w-[var(--factory-run-panel-width,21.25rem)] max-w-[50%] shrink-0 flex-col border-l bg-background"
    >
      <PanelResizeHandle label="Resize Run inspector" side="left" bounds={inspectorBounds} />
      {titleGeneration ? (
        <RunTitleView generation={titleGeneration} onBack={() => onSelect(null)} />
      ) : block && recorded ? (
        <RunBlockView
          run={run}
          block={block}
          recorded={recorded}
          observationUnavailable={observationUnavailable}
          onBack={() => onSelect(null)}
        />
      ) : (
        <RunOverview
          run={run}
          project={project}
          projectUnavailable={projectUnavailable}
          observationUnavailable={observationUnavailable}
        />
      )}
    </aside>
  );
}
