import { RetryRunSettlement, SettlementWorkers } from "../components/settle-run.tsx";
import { MutationGate } from "@/client-gate";
import { RootWork } from "../components/run-coordination-controls.tsx";
import { RunRepositories } from "../components/run-repositories.tsx";
import {
  BindingLink,
  bindingRole,
  CoordinatorActivations,
} from "../components/run-coordination.tsx";
import { CanvasLayout } from "../components/screen-layout.tsx";
import { RunConversationAction, RunConversationNotice } from "../components/run-conversation.tsx";
import { useSettings, useStudio } from "../settings-navigation.ts";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  attentionPresentation,
  type ContinuationVisit,
  type FactoryProject,
  type FlowBlock,
  type RunBlock,
  type RunDetail,
} from "@t3-factory/contracts";
import { CONTINUATION_EXIT } from "@t3-factory/domain-validation";
import {
  Archive,
  CircleCheck,
  CircleHelp,
  Ellipsis,
  GitBranch,
  Lock,
  TriangleAlert,
  Unplug,
  Workflow,
  X,
} from "lucide-react";
import {
  pendingRecovery,
  RequestReport,
  RunAttentionDetails,
} from "../components/run-attention.tsx";
import { ArchiveRunDialog } from "../components/archive-run-dialog.tsx";
import { RunNumber } from "../components/run-number.tsx";
import { RunTimeline } from "../components/run-timeline.tsx";
import {
  blockVisits,
  continuationPromptVisit,
  ExecutionCanvas,
  threadOwnerName,
  waitingText,
} from "../components/execution-canvas.tsx";
import { BLOCK_KINDS, exitDisplayName } from "../components/flow-block.tsx";
import { WaitArrivals } from "../components/wait-arrivals.tsx";
import { waitDurationText } from "../wait-display.ts";
import { clockTime, dayAndTime, StatePill } from "../components/execution-state.tsx";
import { Notice, NoticeSettingsLink } from "../components/notice.tsx";
import { sectionLabelClass } from "../components/page.tsx";
import { useConnectionState } from "../connection-state.tsx";
import { OpenRunKeyboardHost } from "../open-run-keyboard.tsx";
import { useLiveNavigation } from "../live/navigation.ts";
import { useShortcutPreferences } from "../shortcut-preferences.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { capturedExits, continuedThread, exitRecipients } from "../flow-graph.ts";
import { api, ApiError } from "../api.ts";
import { useLiveRun } from "../live/run.ts";
import { useLiveDelivery } from "../transport.ts";
import { RunInitialPrompt } from "../components/run-prompt.tsx";
import { PanelResizeHandle, type PanelBounds } from "../components/panel-resize.tsx";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function elapsedSeconds(from: string, to: string) {
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000).toFixed(1);
}

type CurrentFlowRevision = { readonly revision: number } | "missing";

/** Run detail is live; descriptive catalogs are read once for this screen entry. */
function useRunObservation(id: string) {
  const { value: run, error: scopeError, synchronized } = useLiveRun(id);
  const delivery = useLiveDelivery();
  const [catalog, setCatalog] = useState<readonly FactoryProject[]>();
  const [definition, setDefinition] = useState<CurrentFlowRevision>();
  const flowId = run?.flowId;
  useEffect(() => {
    let active = true;
    setCatalog(undefined);
    void api.listProjects().then(
      (catalog) => {
        if (active) setCatalog(catalog.projects);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    let active = true;
    setDefinition(undefined);
    if (flowId)
      void api.getFlow(flowId).then(
        (flow) => {
          if (active) setDefinition({ revision: flow.revision });
        },
        (error: unknown) => {
          if (active && error instanceof ApiError && error.detail.code === "not_found")
            setDefinition("missing");
        },
      );
    return () => {
      active = false;
    };
  }, [id, flowId]);
  const unavailable = !!scopeError || !synchronized || delivery !== "current";
  const error =
    scopeError?.message ??
    ((run && unavailable) || delivery === "offline"
      ? "Observations unavailable. Saved history is retained."
      : "");
  return {
    run,
    error,
    unavailable,
    project: catalog?.find((item) => item.id === run?.task.projectId),
    projectsLoaded: catalog !== undefined,
    definition,
  };
}

type RunObservation = ReturnType<typeof useRunObservation>;

/**
 * Marks Woke seen once per opened Run, as soon as its live view is current: the command
 * is refused while delivery synchronizes. Canvas selection and viewport stay out of this.
 */
function useRunOpened(id: string, current: boolean) {
  const location = useLocation();
  const [seenError, setSeenError] = useState("");
  const unmarked = useRef(false);
  useEffect(() => {
    setSeenError("");
    unmarked.current = !location.search.settings;
  }, [id, location]);
  useEffect(() => {
    if (!current || !unmarked.current) return;
    unmarked.current = false;
    let active = true;
    void api
      .markRunWokeSeen(id)
      .then(() => {
        if (active) setSeenError("");
      })
      .catch(() => {
        if (active) setSeenError("Could not mark Woke as seen. Reopen this Run to try again.");
      });
    return () => {
      active = false;
    };
  }, [id, location, current]);
  return seenError;
}

function useEscapeToDeselect(active: boolean, deselect: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      deselect();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, deselect]);
}

/** The context rail and floating block details share one user-resizable width. */
const sidePanelBounds: PanelBounds = {
  variable: "--factory-run-panel-width",
  storageKey: "factory.runSidePanelWidth",
  min: 280,
  max: 640,
};

/** The Run context rail starts open where it fits beside the canvas (Figma C02 hides it on compact). */
function wideViewport() {
  return window.matchMedia("(min-width: 1280px)").matches;
}

export function RunScreen({ id }: { id: string }) {
  const observed = useRunObservation(id);
  const { value: runs } = useLiveNavigation();
  const navigationRun = runs?.find((run) => run.id === id);
  const [selected, setSelected] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(wideViewport);
  const deselect = useCallback(() => setSelected(null), []);
  const seenError = useRunOpened(id, !observed.unavailable);
  useEscapeToDeselect(selected !== null, deselect);
  const { run, error } = observed;
  return (
    <CanvasLayout>
      <OpenRunKeyboardHost
        unavailable={observed.unavailable}
        run={run ?? undefined}
        navigationRun={navigationRun}
      />
      {run ? (
        <RunDetailView
          observed={observed}
          run={run}
          seenError={seenError}
          selected={selected}
          contextOpen={contextOpen}
          onSelect={setSelected}
          onToggleContext={() => setContextOpen((open) => !open)}
        />
      ) : (
        <>
          {(error || seenError) && (
            <Alert variant="destructive" className="m-3 mb-0">
              <AlertDescription>{error || seenError}</AlertDescription>
            </Alert>
          )}
          {!error && <p className="p-6 text-sm text-muted-foreground">Loading Run…</p>}
        </>
      )}
    </CanvasLayout>
  );
}

function RunDetailView({
  observed,
  run,
  seenError,
  selected,
  contextOpen,
  onSelect,
  onToggleContext,
}: {
  observed: RunObservation;
  run: RunDetail;
  seenError: string;
  selected: string | null;
  contextOpen: boolean;
  onSelect: (blockId: string | null) => void;
  onToggleContext: () => void;
}) {
  const settings = useSettings();
  const studio = useStudio();
  const graphBlock = run.definitions.flow.graph.blocks.find((block) => block.id === selected);
  const recorded = run.blocks.find((block) => block.blockId === selected);
  const unavailable = observed.unavailable;
  return (
    <>
      <RunTopBar
        run={run}
        observed={observed}
        contextOpen={contextOpen}
        onToggleContext={onToggleContext}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-72 flex-1">
            <ExecutionCanvas
              shown={!settings && !studio}
              run={run}
              selected={selected}
              observationUnavailable={unavailable}
              onSelect={onSelect}
              overlay={<CanvasOverlay run={run} observed={observed} seenError={seenError} />}
            />
            {graphBlock && recorded && (
              <BlockDetails
                run={run}
                block={graphBlock}
                observationUnavailable={unavailable}
                onClose={() => onSelect(null)}
              />
            )}
          </div>
          {!contextOpen && !selected && run.attention.some((item) => !item.settledAt) && (
            <div className="max-h-60 shrink-0 overflow-auto border-t px-4 py-3">
              <RunAttentionDetails run={run} observationUnavailable={unavailable} />
            </div>
          )}
          {run.settlement && (
            <section
              aria-label="Run settlement"
              className="max-h-72 space-y-3 overflow-auto border-t px-4 py-3"
            >
              <h2 className="text-sm font-semibold">
                {run.settlement.state === "stopping"
                  ? "Stopping workers…"
                  : "Settlement unresolved"}{" "}
                · Attempt {run.settlement.attempt}
              </h2>
              <p className="text-sm text-muted-foreground">
                Automatic work is held until every worker is confirmed finished.
              </p>
              <SettlementWorkers workers={run.settlement.workers} />
              {run.settlement.state === "unresolved" && <RetryRunSettlement id={run.id} />}
            </section>
          )}
          <RunTimeline run={run} selectedBlockId={selected} />
        </div>
        {contextOpen && !selected && (
          <RunContext run={run} observed={observed} observationUnavailable={unavailable} />
        )}
      </div>
    </>
  );
}

/** One header state per distinct recorded block state; untouched blocks only while nothing ran.
 * A Settled Run leads with Settled; its blocks keep their recorded states. */
function headerStates(run: RunDetail) {
  if (run.lifecycle === "archived") return ["archived"];
  const states = [...new Set(run.blocks.map((block) => block.state))];
  const started = states.filter((state) => state !== "not-started");
  return [
    ...(run.lifecycle === "settled" ? ["settled"] : []),
    ...(started.length ? started : states),
  ];
}

function startedBlocks(run: RunDetail) {
  return run.blocks.filter((block) => block.state !== "not-started");
}

function observationText(run: RunDetail, unavailable: boolean) {
  if (unavailable) return "Not live · observations unavailable";
  const started = startedBlocks(run);
  if (started.some((block) => block.freshness === "stale")) return "Not live · last observation";
  if (started.some((block) => block.freshness === "unknown")) return "Unknown observation";
  if (run.runCoordinator) return `Run conversation · ${run.runCoordinator.freshness} observation`;
  return "Bounded local observations";
}

/** Latest recorded observation time across started blocks, shown with a Not live status. */
function lastObservedAt(run: RunDetail) {
  return startedBlocks(run)
    .map((block) => block.observedAt)
    .concat(run.runCoordinator?.observedAt ?? null)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
}

function revisionNote(run: RunDetail, definition: CurrentFlowRevision | undefined) {
  if (!definition) return null;
  if (definition === "missing") return "Flow removed since";
  return definition.revision === run.definitions.flow.revision ? null : "Flow edited since";
}

function projectIsUnavailable(project: FactoryProject | undefined, loaded: boolean) {
  return loaded && (!project || project.availability !== "available");
}

const metaClass = "text-2xs leading-3 text-subtle-foreground";

/** Run top bar: title and meta, Run actions, state and the primary conversation. */
function RunTopBar({
  run,
  observed,
  contextOpen,
  onToggleContext,
}: {
  run: RunDetail;
  observed: RunObservation;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  const { project } = observed;
  const unavailable = projectIsUnavailable(project, observed.projectsLoaded);
  const [archiving, setArchiving] = useState(false);
  const { hint } = useShortcutPreferences();
  const archiveHint = hint("archive");
  const stale =
    run.lifecycle === "active" && observationText(run, observed.unavailable).startsWith("Not live");
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b pr-4 pl-5">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <h1 className="truncate text-base leading-4 font-semibold tracking-[-0.26px]">
          {run.title}
        </h1>
        <p className={cn(metaClass, "flex min-w-0 items-center gap-1.5 whitespace-nowrap")}>
          {run.number !== null && (
            <>
              <RunNumber number={run.number} />
              <span aria-hidden>·</span>
            </>
          )}
          <span className="truncate font-medium">{project?.title ?? "Project"}</span>
          {unavailable && (
            <span className="inline-flex items-center gap-1 rounded-sm border bg-muted px-1.5 py-px font-medium text-muted-foreground">
              <Lock aria-hidden className="size-2.5" strokeWidth={1.75} />
              Project unavailable
            </span>
          )}
          <span aria-hidden>·</span>
          <Workflow aria-hidden className="size-2.75 shrink-0" strokeWidth={1.75} />
          <span className="truncate font-medium">
            <span className="sr-only">Flow for this Run: </span>
            {run.flowName} · captured revision
          </span>
          <span className="tracking-label">· Started {dayAndTime(run.startedAt)}</span>
        </p>
      </div>
      {run.lifecycle !== "archived" && (
        <>
          <MutationGate>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" onClick={() => setArchiving(true)}>
                  <Archive aria-hidden />
                  Archive Run
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Archive Run…{archiveHint !== "Unbound" ? ` · ${archiveHint}` : ""}
              </TooltipContent>
            </Tooltip>
          </MutationGate>
          <ArchiveRunDialog run={run} open={archiving} onOpenChange={setArchiving} />
        </>
      )}
      {stale && <span className="text-2xs font-medium text-attention">Last known</span>}
      <div role="status" aria-label="Run status" className="flex items-center gap-1.5">
        {headerStates(run).map((state) => (
          <StatePill key={state} state={state} />
        ))}
      </div>
      <RunConversationAction run={run} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Run actions">
            <Ellipsis aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onToggleContext}>
            {contextOpen ? "Hide Run context" : "Show Run context"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

const canvasBadgeClass =
  "flex h-7 items-center gap-1.5 rounded-md border bg-muted pr-2.5 pl-2.25 text-2xs leading-3 whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0";

/** Figma Run/SnapshotBadge: the canvas renders the Flow revision captured at Start. */
function RevisionBadge({ run, note }: { run: RunDetail; note: string | null }) {
  return (
    <div className={canvasBadgeClass}>
      <Lock aria-hidden strokeWidth={1.75} className="text-muted-foreground" />
      <span className="font-semibold tracking-section text-foreground">Flow revision</span>
      <span className="truncate tracking-label text-muted-foreground">
        {run.definitions.flow.name} · captured at Start
      </span>
      <span className="sr-only"> · </span>
      <span aria-hidden className="h-3 w-px bg-border" />
      <span className="font-medium text-subtle-foreground">read-only</span>
      {note && (
        <>
          <span aria-hidden className="h-3 w-px bg-border" />
          <span className="font-medium text-attention">{note}</span>
        </>
      )}
    </div>
  );
}

/** When the Run last entered `kind`; Runs settled or archived by an upgrade have no such event. */
function lifecycleAt(run: RunDetail, kind: "run-settled" | "run-archived") {
  return run.events.findLast((event) => event.kind === kind)?.observedAt;
}

/** Figma Run/CanvasStatus: Live, Not live (last observation), Settled, or Archived history. */
function ObservationBadge({ run, unavailable }: { run: RunDetail; unavailable: boolean }) {
  const text = observationText(run, unavailable);
  const settled = run.lifecycle === "settled";
  const notLive = !settled && text.startsWith("Not live");
  const last = notLive ? lastObservedAt(run) : undefined;
  let icon = <CircleHelp aria-hidden strokeWidth={1.75} />;
  let label = text;
  if (run.lifecycle === "archived") {
    const at = lifecycleAt(run, "run-archived");
    icon = <Archive aria-hidden strokeWidth={1.75} />;
    label = at ? `Archived ${dayAndTime(at)} · history` : "Archived · history";
  } else if (settled) {
    const at = lifecycleAt(run, "run-settled");
    icon = <CircleCheck aria-hidden strokeWidth={1.75} className="text-success" />;
    label = at ? `Settled ${dayAndTime(at)}` : "Settled";
  } else if (notLive) {
    icon = <Unplug aria-hidden strokeWidth={1.75} />;
    label = last ? `Not live · last observed ${clockTime(last)}` : text;
  } else if (text === "Live") {
    icon = <CircleCheck aria-hidden strokeWidth={1.75} className="text-success" />;
    label = "Live · updated just now";
  }
  return (
    <p
      role="status"
      aria-label="Run observation"
      className={cn(
        canvasBadgeClass,
        "font-medium",
        notLive ? "border-attention/50 bg-attention/10 text-attention" : "text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </p>
  );
}

function CanvasOverlay({
  run,
  observed,
  seenError,
}: {
  run: RunDetail;
  observed: RunObservation;
  seenError: string;
}) {
  // Start and live observation depend on readiness: keep it current while shown.
  const { presentation } = useConnectionState();
  const unavailable = projectIsUnavailable(observed.project, observed.projectsLoaded);
  const projectTitle = observed.project?.title ?? "This project";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <RevisionBadge run={run} note={revisionNote(run, observed.definition)} />
        <ObservationBadge run={run} unavailable={observed.unavailable} />
      </div>
      <RunConversationNotice coordinator={run.runCoordinator} />
      {observed.error && (
        <Notice tone="critical" icon={TriangleAlert} title={observed.error} className="w-140" />
      )}
      {seenError && (
        <Notice tone="attention" icon={TriangleAlert} title={seenError} className="w-140" />
      )}
      {run.lifecycle !== "archived" && presentation === "unavailable" && (
        <Notice
          tone="critical"
          icon={Unplug}
          title="T3 is disconnected"
          className="w-140"
          action={
            <NoticeSettingsLink selection={{ tab: "connection" }}>
              Open T3 connection settings
            </NoticeSettingsLink>
          }
        >
          Showing what Factory last observed. Blocks won’t advance here until Factory reconnects;
          nothing is lost.
        </Notice>
      )}
      {unavailable && (
        <Notice
          tone="attention"
          icon={TriangleAlert}
          title="Project unavailable in T3"
          className="w-140"
        >
          {run.lifecycle === "archived"
            ? `${projectTitle} is no longer available in T3. This history and its captured Flow revision stay readable; T3 thread links may not open.`
            : `T3 no longer reports ${projectTitle}. Threads already running continue in T3; Factory can’t start new steps in this project until it’s available again.`}
        </Notice>
      )}
    </>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className={cn(sectionLabelClass, "px-2")}>{title}</h3>
      {children}
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function visitSpan(visit: ReturnType<typeof blockVisits>[number]) {
  return `${visit.start ? clockTime(visit.start) : "—"} → ${visit.end ? clockTime(visit.end) : "now"}`;
}

function blockAttentionLabel(run: RunDetail, blockId: string) {
  const pending = run.attention.filter((item) => item.blockId === blockId && !item.settledAt);
  const labels = [
    pending.some((item) => attentionPresentation(item.kind) === "needs-input") && "Needs input",
    pending.some((item) => attentionPresentation(item.kind) === "problem") && "Problem",
  ].filter(Boolean);
  return labels.length ? labels.join(" · ") : "None";
}

function blockKindLine(run: RunDetail, block: FlowBlock) {
  if (block.kind === "human") return "Human step · asks you";
  if (block.kind === "wait") return `Wait · ${waitDurationText(block.duration)} · no worker`;
  if (block.kind === "continuation") {
    const thread = continuedThread(run.definitions.flow.graph, block.id);
    return `Continuation · ${thread ? `continues ${thread}` : "no Agent before it"}`;
  }
  const agent = run.definitions.agents.find((item) => item.id === block.agentId)?.name;
  const input = run.definitions.flow.graph.flowInput.targetBlockIds.includes(block.id)
    ? " · receives the Flow input"
    : "";
  return `Agent · ${agent ?? "not chosen"}${input}`;
}

/** Execution, visits and exits of an Agent block, Human step or Wait; a Wait lists its arrivals. */
function BlockHistory({
  run,
  block,
  recorded,
  observationUnavailable,
}: {
  run: RunDetail;
  block: FlowBlock;
  recorded: RunBlock;
  observationUnavailable: boolean;
}) {
  const visits = blockVisits(run, block);
  return (
    <>
      <DetailSection title="Execution">
        <dl className="flex flex-col gap-2">
          <DetailRow label="Visits">{visits.length}</DetailRow>
          <DetailRow label="Current">{currentVisitText(run, block, visits)}</DetailRow>
          <DetailRow label="Attention">{blockAttentionLabel(run, block.id)}</DetailRow>
          <DetailRow label="Observation">
            {observationUnavailable ? "stale" : recorded.freshness}
            {recorded.observedAt ? ` · ${dayAndTime(recorded.observedAt)}` : ""}
          </DetailRow>
        </dl>
      </DetailSection>
      {block.kind === "wait" && <WaitArrivals run={run} blockId={block.id} />}
      {block.kind !== "wait" && visits.length > 0 && (
        <DetailSection title={`Visits · ${visits.length}`}>
          <ul className="flex flex-col gap-1.5">
            {visits
              .map((visit, index) => ({ visit, number: index + 1 }))
              .reverse()
              .map(({ visit, number }) => (
                <li
                  key={visit.id}
                  className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Visit {number}</p>
                    <p className="truncate text-2xs tracking-label text-subtle-foreground">
                      {visitSpan(visit)} · {visit.id}
                    </p>
                  </div>
                  <StatePill
                    state={
                      block.kind === "agent" && number === visits.length
                        ? recorded.state
                        : visit.status
                    }
                  />
                </li>
              ))}
          </ul>
        </DetailSection>
      )}
      <DetailSection title="Exits in captured revision">
        <ul className="flex flex-col gap-1.5 px-2">
          {capturedExits(run.definitions, block.id).map((exit) => {
            const recipients = exitRecipients(run.definitions.flow.graph, block.id, exit.id);
            return (
              <li key={exit.id} className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{exitDisplayName(exit, "Output")}</span>
                <span className="shrink-0 text-2xs tracking-label text-subtle-foreground">
                  {recipients.length ? `→ ${recipients.join(", ")}` : "ends branch"}
                </span>
              </li>
            );
          })}
        </ul>
      </DetailSection>
    </>
  );
}

/** The current `working` report and Request report; a sent Continuation reports like an Agent. */
function WorkingReport({ run, recorded }: { run: RunDetail; recorded: RunBlock }) {
  if (recorded.state !== "working" && recorded.state !== "sent") return null;
  if (!recorded.workingMessage) return null;
  return (
    <DetailSection title="Working report">
      <div className="flex flex-col gap-3 px-2">
        <p className="text-sm break-words whitespace-pre-wrap text-foreground">
          {recorded.workingMessage}
        </p>
        <RequestReport
          run={run}
          blockId={recorded.blockId}
          executionId={recorded.executionId}
          recovery={pendingRecovery(run, recorded)}
        />
      </div>
    </DetailSection>
  );
}

/** The current visit, or a waiting Wait's nearest deadline. */
function currentVisitText(
  run: RunDetail,
  block: FlowBlock,
  visits: ReturnType<typeof blockVisits>,
) {
  const waiting = block.kind === "wait" && waitingText(run, block.id);
  if (waiting) return waiting;
  const latest = visits[visits.length - 1];
  if (!latest) return "Not visited";
  return `visit ${visits.length}${latest.start ? ` · since ${clockTime(latest.start)}` : ""}`;
}

type ContinuationBlock = Extract<FlowBlock, { kind: "continuation" }>;

function bindingLink(run: RunDetail, bindingId: string | null) {
  return run.threadBindings.find((binding) => binding.id === bindingId)?.link ?? null;
}

function sourceName(run: RunDetail, visit: ContinuationVisit) {
  if (!visit.sourceBlockId) return "the Flow input";
  return (
    run.definitions.flow.graph.blocks.find((block) => block.id === visit.sourceBlockId)?.name ||
    visit.sourceBlockId
  );
}

/** The worker's finished response to the prompt, reported against the prompt visit's activation. */
function continuationResponse(run: RunDetail, prompt: ContinuationVisit | undefined) {
  if (!prompt?.activationId) return null;
  return (
    run.reports.findLast(
      (report) => report.activationId === prompt.activationId && report.status === "finished",
    )?.resultMessage ?? null
  );
}

/** A Continuation's prompt, its response and every message that reached it, oldest first. */
function ContinuationHistory({ run, block }: { run: RunDetail; block: ContinuationBlock }) {
  const visits = run.continuationVisits.filter((visit) => visit.blockId === block.id);
  const prompt = visits.find((visit) => visit.kind === "prompt");
  const ordered = [...(prompt ? [prompt] : []), ...visits.filter((visit) => visit !== prompt)];
  return (
    <>
      <ContinuationExecution run={run} block={block} visits={visits} prompt={prompt} />
      <ContinuationExchange run={run} block={block} prompt={prompt} />
      {ordered.length > 0 && (
        <DetailSection title={`Visits · ${ordered.length}`}>
          <ul className="flex flex-col gap-1.5">
            {ordered.map((visit, index) => (
              <ContinuationVisitItem key={visit.id} run={run} visit={visit} number={index + 1} />
            ))}
          </ul>
        </DetailSection>
      )}
      <DetailSection title="Output">
        <ContinuationRecipients run={run} blockId={block.id} />
      </DetailSection>
    </>
  );
}

function ContinuationExecution({
  run,
  block,
  visits,
  prompt,
}: {
  run: RunDetail;
  block: ContinuationBlock;
  visits: readonly ContinuationVisit[];
  prompt: ContinuationVisit | undefined;
}) {
  const queued = visits.filter((visit) => visit.state === "queued").length;
  const owner = prompt?.state === "sent" ? threadOwnerName(run, prompt.bindingId) : null;
  return (
    <DetailSection title="Execution">
      <dl className="flex flex-col gap-2">
        <DetailRow label="Prompt">
          {prompt ? `sent ${clockTime(prompt.arrivedAt)} · once in this Run` : "not sent"}
        </DetailRow>
        {owner && <DetailRow label="Work">{owner}&apos;s thread</DetailRow>}
        <DetailRow label="Queued">
          {queued ? `${queued} waiting behind the response` : "none"}
        </DetailRow>
        <DetailRow label="Attention">{blockAttentionLabel(run, block.id)}</DetailRow>
      </dl>
    </DetailSection>
  );
}

const exchangeCardClass = "flex flex-col gap-0.5 rounded-md border bg-muted px-3 py-2";
const exchangeTextClass = "line-clamp-3 text-2xs tracking-label break-words text-subtle-foreground";

/** Input → prompt → response of the prompt visit; the prompt is the captured revision's. */
function ContinuationExchange({
  run,
  block,
  prompt,
}: {
  run: RunDetail;
  block: ContinuationBlock;
  prompt: ContinuationVisit | undefined;
}) {
  const response = continuationResponse(run, prompt);
  const owner = prompt ? threadOwnerName(run, prompt.bindingId) : null;
  return (
    <DetailSection title="Input → prompt → response">
      <div className="flex flex-col gap-1.5">
        <div className={exchangeCardClass}>
          <p className="text-sm font-medium">
            Input{prompt ? ` · from ${sourceName(run, prompt)}` : ""}
          </p>
          <p className={exchangeTextClass}>
            {prompt ? `arrived ${clockTime(prompt.arrivedAt)}` : "no message yet"}
          </p>
        </div>
        <div className={exchangeCardClass}>
          <p className="text-sm font-medium">
            {prompt ? `Prompt sent${owner ? ` to ${owner}'s thread` : ""}` : "Prompt · not sent"}
          </p>
          <p className={exchangeTextClass} title={block.prompt}>
            {block.prompt || "No prompt in the captured revision"}
          </p>
        </div>
        <div className={exchangeCardClass}>
          <p className="text-sm font-medium">Response</p>
          <p className={exchangeTextClass} title={response ?? undefined}>
            {response ?? "not yet"}
          </p>
        </div>
      </div>
    </DetailSection>
  );
}

/** Visit pills say what the message did: sent the prompt, passed through, or still waits. */
function visitPill(visit: ContinuationVisit) {
  if (visit.state === "queued" || visit.state === "cancelled") return visit.state;
  return visit.kind === "prompt" ? "sent" : "pass-through";
}

function visitLine(run: RunDetail, visit: ContinuationVisit) {
  const source = sourceName(run, visit);
  if (visit.kind === "prompt") {
    const end = visit.forwardedAt ? clockTime(visit.forwardedAt) : "now";
    return `${clockTime(visit.arrivedAt)}–${end} · from ${source}`;
  }
  if (visit.state === "queued")
    return `${clockTime(visit.arrivedAt)} · ${source}'s message waits behind the prompt`;
  return `${clockTime(visit.arrivedAt)} · ${source}'s message, unchanged · no prompt`;
}

function ContinuationVisitItem({
  run,
  visit,
  number,
}: {
  run: RunDetail;
  visit: ContinuationVisit;
  number: number;
}) {
  const link = bindingLink(run, visit.bindingId);
  return (
    <li className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">
          Visit {number} · {visit.kind}
        </p>
        <p className="text-2xs tracking-label break-words text-subtle-foreground">
          {visitLine(run, visit)}
        </p>
        {link && (
          <a
            className="w-fit rounded-sm text-2xs font-medium text-link outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            href={link}
            target="_blank"
            rel="noreferrer"
          >
            Open thread in T3
          </a>
        )}
      </div>
      <StatePill state={visitPill(visit)} />
    </li>
  );
}

function ContinuationRecipients({ run, blockId }: { run: RunDetail; blockId: string }) {
  const recipients = exitRecipients(run.definitions.flow.graph, blockId, CONTINUATION_EXIT.id);
  return (
    <p className="flex items-baseline gap-2 px-2 text-sm">
      <span className="min-w-0 flex-1 truncate">response, then pass-through</span>
      <span className="shrink-0 text-2xs tracking-label text-subtle-foreground">
        {recipients.length ? `→ ${recipients.join(", ")}` : "ends branch"}
      </span>
    </p>
  );
}

/** Figma RD01b: block details float over the canvas; selection never answers or settles attention. */
function BlockDetails({
  run,
  block,
  observationUnavailable,
  onClose,
}: {
  run: RunDetail;
  block: FlowBlock;
  observationUnavailable: boolean;
  onClose: () => void;
}) {
  const recorded = run.blocks.find((item) => item.blockId === block.id);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, [block.id]);
  if (!recorded) return null;
  const KindIcon = BLOCK_KINDS[block.kind].Icon;
  // A Continuation has no thread of its own: its prompt ran on the thread of its prompt visit.
  const promptBinding = run.threadBindings.find(
    (binding) => binding.id === continuationPromptVisit(run, block.id)?.bindingId,
  );
  const link = recorded.link ?? promptBinding?.link ?? null;
  const threadId = recorded.threadId ?? promptBinding?.threadId;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Block details"
      className="absolute top-3 right-3 bottom-3 z-20 flex w-[var(--factory-run-panel-width,21.25rem)] max-w-[calc(100%-1.5rem)] flex-col rounded-xl border bg-card shadow-panel outline-none"
    >
      <header className="flex items-start gap-2.5 px-4 pt-4 pb-3">
        <KindIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base leading-4 font-semibold">{block.name}</h2>
          <p className="mt-0.5 truncate text-2xs tracking-label text-subtle-foreground">
            {blockKindLine(run, block)}
          </p>
        </div>
        <StatePill state={recorded.state} />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close block details"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-4">
        <RunAttentionDetails
          run={run}
          blockId={block.id}
          observationUnavailable={observationUnavailable}
        />
        <WorkingReport run={run} recorded={recorded} />
        <CoordinatorActivations run={run} blockId={block.id} />
        {block.kind === "continuation" ? (
          <ContinuationHistory run={run} block={block} />
        ) : (
          <BlockHistory
            run={run}
            block={block}
            recorded={recorded}
            observationUnavailable={observationUnavailable}
          />
        )}
        {block.kind !== "wait" && (
          <DetailSection title="T3 references">
            <p className="px-2 font-mono text-2xs leading-4 break-all text-muted-foreground">
              Thread: {threadId ?? "unresolved"}
              <br />
              Exact execution: {recorded.executionId ?? "unresolved"}
            </p>
          </DetailSection>
        )}
      </div>
      <footer className="mx-4 flex items-center gap-3 border-t py-4">
        {link ? (
          <a
            className="inline-flex h-8 shrink-0 items-center rounded-md border bg-background px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            href={link}
            target="_blank"
            rel="noreferrer"
          >
            Open thread in T3
          </a>
        ) : (
          <span className="shrink-0 text-2xs tracking-label text-subtle-foreground">
            {block.kind === "wait" ? "A Wait has no T3 thread" : "No T3 thread yet"}
          </span>
        )}
        <p className="text-2xs tracking-label text-subtle-foreground">
          Selecting never answers or clears attention
        </p>
      </footer>
      <PanelResizeHandle label="Resize block details" side="left" bounds={sidePanelBounds} />
    </aside>
  );
}

/** Run context rail (Figma A03 inspector): attention, prompt, Flow revision, project. */
function RunContext({
  run,
  observed,
  observationUnavailable,
}: {
  run: RunDetail;
  observed: RunObservation;
  observationUnavailable: boolean;
}) {
  const unavailable = projectIsUnavailable(observed.project, observed.projectsLoaded);
  return (
    <aside
      aria-label="Run context"
      className="relative flex w-[var(--factory-run-panel-width,20rem)] max-w-[50%] shrink-0 border-l bg-background"
    >
      <PanelResizeHandle label="Resize Run context" side="left" bounds={sidePanelBounds} />
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-auto px-5 py-5">
        <RunAttentionDetails run={run} observationUnavailable={observationUnavailable} />
        <RootWork run={run} />
        <CoordinatorActivations run={run} />
        <PendingIntents run={run} />
        {run.repositories.some((worker) => worker.branch || worker.pullRequests.length > 0) && (
          <ContextSection title="Branches and pull requests" label="Run repositories">
            <RunRepositories workers={run.repositories} links />
          </ContextSection>
        )}
        <ContextSection title="Initial prompt" label="Run input">
          <RunInitialPrompt run={run} />
        </ContextSection>
        <ContextSection title="Flow revision">
          <p className="text-sm text-emphasis-foreground">
            {run.definitions.flow.name} — captured at Start. Later Flow edits do not change this
            Run.
          </p>
        </ContextSection>
        <RunWorkspace run={run} />
        <ContextSection title="Project">
          <p className="text-sm text-emphasis-foreground">
            {observed.project?.title ?? "Project"}
            {unavailable ? " — unavailable in T3. History stays readable." : ""}
          </p>
        </ContextSection>
        <WorkPeriods run={run} />
      </div>
    </aside>
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
      <ContextSection title="Workspace" label="Run workspace">
        <p className="text-sm text-emphasis-foreground">Project checkout</p>
        <p className={railTextClass}>Every worker of this Run works in the project root.</p>
      </ContextSection>
    );
  return (
    <ContextSection title="Workspace" label="Run workspace">
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
      <p className={railTextClass}>
        New worktree from {workspace.baseRef}
        {worktreeNote[workspace.state]}
      </p>
      {workspace.problem && (
        <p
          role="status"
          className={cn(
            "rounded-md border p-3 text-2xs leading-4 tracking-label text-emphasis-foreground",
            workspace.state === "failed"
              ? "border-destructive/40 bg-destructive/8"
              : "border-attention/40 bg-attention/8",
          )}
        >
          {workspace.problem}
        </p>
      )}
    </ContextSection>
  );
}

function ContextSection({
  title,
  label,
  children,
}: {
  title: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={label}>
      <h2 className={sectionLabelClass}>{title}</h2>
      {children}
    </section>
  );
}

const railTextClass = "text-2xs leading-4 tracking-label text-muted-foreground";

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
          className="rounded-md border border-attention/40 bg-attention/8 p-3 text-2xs leading-4 tracking-label text-emphasis-foreground"
        >
          {intent.state === "pending" ? `${intent.kind} pending` : `Uncertain ${intent.kind}`}:{" "}
          {intent.kind === "handoff" && intent.state === "pending" ? (
            (intent.problem ?? "Handoff held; delivery has not started.")
          ) : (
            <>
              {intent.problem ?? "Awaiting the exact T3 reference."} Recovery is automatic when
              supported; this remains the same Run.
            </>
          )}
        </p>
      ))}
    </div>
  );
}

function T3Link({ href }: { href: string }) {
  return (
    <a
      className="w-fit rounded-sm text-2xs font-medium text-link outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      Open in T3
    </a>
  );
}

function observedTime(at: string | null | undefined) {
  return at ? new Date(at).toLocaleString() : "not yet observed";
}

function WorkPeriods({ run }: { run: RunDetail }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Work periods">
      <h2 className={sectionLabelClass}>Work periods</h2>
      <p className={railTextClass}>
        Each execution is independent. Start/end and elapsed times are approximate observations.
        Queue acknowledgement does not start a work period.
      </p>
      {run.executions.map((execution) => {
        const block = run.blocks.find((item) => item.blockId === execution.blockId);
        const binding = run.threadBindings.find((item) => item.id === execution.bindingId);
        return (
          <article
            className="flex flex-col gap-1 rounded-md border bg-muted p-3 text-2xs leading-4 tracking-label text-muted-foreground"
            key={`${execution.bindingId}/${execution.executionId}`}
            aria-label={`${binding ? bindingRole[binding.role] : "Agent"} · ${execution.executionId}`}
          >
            <h3 className="text-sm font-medium tracking-normal text-foreground">
              {block?.name ?? execution.blockId} ·{" "}
              {binding ? `${bindingRole[binding.role]} · ` : ""}
              {execution.executionId}
            </h3>
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
                <p>Thread: {binding.threadId}</p>
                <BindingLink binding={binding} />
              </>
            ) : (
              block?.link && <T3Link href={block.link} />
            )}
          </article>
        );
      })}
    </section>
  );
}
