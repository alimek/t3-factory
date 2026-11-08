import { RootWork } from "../components/run-coordination-controls.tsx";
import {
  BindingLink,
  bindingRole,
  CoordinatorActivations,
} from "../components/run-coordination.tsx";
import { CanvasLayout } from "../components/screen-layout.tsx";
import { RunConversationAction, RunConversationNotice } from "../components/run-conversation.tsx";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  attentionPresentation,
  type FactoryProject,
  type FlowBlock,
  type RunDetail,
} from "@t3-factory/contracts";
import {
  Archive,
  Bot,
  CircleCheck,
  CircleHelp,
  CircleStop,
  Ellipsis,
  Lock,
  TriangleAlert,
  Unplug,
  User,
  Workflow,
  X,
} from "lucide-react";
import {
  pendingRecovery,
  RequestReport,
  RunAttentionDetails,
} from "../components/run-attention.tsx";
import { RunTimeline } from "../components/run-timeline.tsx";
import { blockVisits, ExecutionCanvas } from "../components/execution-canvas.tsx";
import { clockTime, dayAndTime, StatePill } from "../components/execution-state.tsx";
import { Notice, NoticeSettingsLink } from "../components/notice.tsx";
import { sectionLabelClass } from "../components/page.tsx";
import { useConnectionState, useConnectionWatch } from "../connection-state.tsx";
import { exitRecipients } from "../flow-graph.ts";
import { api, ApiError } from "../api.ts";
import { usePolling } from "../use-polling.ts";

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

function blockName(run: RunDetail, blockId: string) {
  return run.blocks.find((block) => block.blockId === blockId)?.name;
}

type CurrentFlowRevision = { readonly revision: number } | "missing";

/** Polls the Run with its project and whether its captured Flow revision is still current. */
function useRunObservation(id: string) {
  const [run, setRun] = useState<RunDetail>();
  const [error, setError] = useState("");
  const [project, setProject] = useState<FactoryProject>();
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [definition, setDefinition] = useState<CurrentFlowRevision>();
  usePolling({
    intervalMs: 1500,
    onPoll: useCallback(
      (isActive) =>
        api
          .getRun(id)
          .then(async (runDetail) => {
            if (!isActive()) return;
            setRun(runDetail);
            setError("");
            const [catalog, flowDefinition] = await Promise.all([
              api.listProjects(),
              api.getFlow(runDetail.flowId).then(
                (flow) => ({ revision: flow.revision }) satisfies CurrentFlowRevision,
                (error: unknown) =>
                  error instanceof ApiError && error.detail.code === "not_found"
                    ? ("missing" as const)
                    : undefined,
              ),
            ]);
            if (!isActive()) return;
            setProject(catalog.projects.find((item) => item.id === runDetail.task.projectId));
            setProjectsLoaded(true);
            // A transient Flow read failure keeps the last known state instead of claiming removal.
            if (flowDefinition) setDefinition(flowDefinition);
          })
          .catch(() => {
            if (isActive()) setError("Observations unavailable. Saved history is retained.");
          }),
      [id],
    ),
  });
  return { run, setRun, error, project, projectsLoaded, definition };
}

type RunObservation = ReturnType<typeof useRunObservation>;

/**
 * One effect per opened Run. Marks Woke seen for this id.
 * Canvas selection and viewport state stay out of this effect.
 */
function useRunOpened(id: string) {
  const location = useLocation();
  const [seenError, setSeenError] = useState("");
  useEffect(() => {
    let active = true;
    setSeenError("");
    const markSeen = () => {
      if (location.search.settings) return;
      void api
        .markRunWokeSeen(id)
        .then(() => {
          if (active) setSeenError("");
        })
        .catch(() => {
          if (active) setSeenError("Could not mark Woke as seen. Reopen this Run to try again.");
        });
    };
    markSeen();

    return () => {
      active = false;
    };
  }, [id, location]);
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

/** Stop is requested from the top bar; its saved state and caveats show in the Run context. */
function useStopRun(run: RunDetail, onStopped: (run: RunDetail) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function stop() {
    setBusy(true);
    setError("");
    try {
      onStopped(await api.stopRun(run.id));
    } catch {
      setError(
        "Stop response unavailable. Retry Stop to recover its saved state; confirmation has not been established.",
      );
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, stop };
}

type StopControl = ReturnType<typeof useStopRun>;

/** The Run context rail starts open where it fits beside the canvas (Figma C02 hides it on compact). */
function wideViewport() {
  return window.matchMedia("(min-width: 1280px)").matches;
}

export function RunScreen({ id }: { id: string }) {
  const observed = useRunObservation(id);
  const [selected, setSelected] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(wideViewport);
  const deselect = useCallback(() => setSelected(null), []);
  const seenError = useRunOpened(id);
  useEscapeToDeselect(selected !== null, deselect);
  const { run, error } = observed;
  return (
    <CanvasLayout>
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
          <p className="p-6 text-sm text-muted-foreground">Loading Run…</p>
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
  const graphBlock = run.definitions.flow.graph.blocks.find((block) => block.id === selected);
  const recorded = run.blocks.find((block) => block.blockId === selected);
  const stop = useStopRun(run, observed.setRun);
  const unavailable = !!observed.error;
  return (
    <>
      <RunTopBar
        run={run}
        observed={observed}
        stop={stop}
        contextOpen={contextOpen}
        onToggleContext={onToggleContext}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-72 flex-1">
            <ExecutionCanvas
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
                onUpdated={observed.setRun}
              />
            )}
          </div>
          {!contextOpen && !selected && run.attention.some((item) => !item.settledAt) && (
            <div className="max-h-60 shrink-0 overflow-auto border-t px-4 py-3">
              <RunAttentionDetails
                run={run}
                observationUnavailable={unavailable}
                onUpdated={observed.setRun}
              />
            </div>
          )}
          <RunTimeline run={run} selectedBlockId={selected} />
        </div>
        {contextOpen && !selected && (
          <RunContext
            run={run}
            observed={observed}
            stop={stop}
            observationUnavailable={unavailable}
          />
        )}
      </div>
    </>
  );
}

/** One header state per distinct recorded block state; untouched blocks only while nothing ran.
 * A Settled Run leads with Settled; its blocks keep their recorded states. */
function headerStates(run: RunDetail) {
  if (run.outcome === "stopped") return ["stopped"];
  if (run.stopRequestedAt) return ["stopping"];
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
  stop,
  contextOpen,
  onToggleContext,
}: {
  run: RunDetail;
  observed: RunObservation;
  stop: StopControl;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  const { project } = observed;
  const unavailable = projectIsUnavailable(project, observed.projectsLoaded);
  const stale =
    run.lifecycle === "active" &&
    !run.closedAt &&
    observationText(run, !!observed.error).startsWith("Not live");
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b pr-4 pl-5">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <h1 className="truncate text-base leading-4 font-semibold tracking-[-0.26px]">
          {run.title}
        </h1>
        <p className={cn(metaClass, "flex min-w-0 items-center gap-1.5 whitespace-nowrap")}>
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
      {!run.closedAt && !run.stopRequestedAt && (
        <Button
          type="button"
          variant="outline"
          disabled={stop.busy}
          onClick={() => void stop.stop()}
        >
          {stop.busy ? "Requesting Stop…" : "Stop Run"}
        </Button>
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

/** When the Run last became Settled; Runs settled by an upgrade have no such event. */
function settledAt(run: RunDetail) {
  return run.events.findLast((event) => event.kind === "run-settled")?.observedAt;
}

/** Figma Run/CanvasStatus: Live, Not live (last observation), Settled, or History for a closed Run. */
function ObservationBadge({ run, unavailable }: { run: RunDetail; unavailable: boolean }) {
  const text = observationText(run, unavailable);
  const settled = run.lifecycle === "settled";
  const notLive = !settled && text.startsWith("Not live");
  const last = notLive ? lastObservedAt(run) : undefined;
  let icon = <CircleHelp aria-hidden strokeWidth={1.75} />;
  let label = text;
  if (run.closedAt) {
    icon = <Archive aria-hidden strokeWidth={1.75} />;
    label = `History · execution closed ${dayAndTime(run.closedAt)}`;
  } else if (settled) {
    const at = settledAt(run);
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
        notLive && !run.closedAt
          ? "border-attention/50 bg-attention/10 text-attention"
          : "text-muted-foreground",
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
  useConnectionWatch("always");
  const { presentation } = useConnectionState();
  const unavailable = projectIsUnavailable(observed.project, observed.projectsLoaded);
  const projectTitle = observed.project?.title ?? "This project";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <RevisionBadge run={run} note={revisionNote(run, observed.definition)} />
        <ObservationBadge run={run} unavailable={!!observed.error} />
      </div>
      <RunConversationNotice coordinator={run.runCoordinator} />
      {observed.error && (
        <Notice tone="critical" icon={TriangleAlert} title={observed.error} className="w-140" />
      )}
      {seenError && (
        <Notice tone="attention" icon={TriangleAlert} title={seenError} className="w-140" />
      )}
      {!run.closedAt && presentation === "unavailable" && (
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
          {run.closedAt
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
  const agent = run.definitions.agents.find((item) => item.id === block.agentId)?.name;
  const input = run.definitions.flow.graph.flowInput.targetBlockIds.includes(block.id)
    ? " · receives the Flow input"
    : "";
  return `Agent · ${agent ?? "not chosen"}${input}`;
}

/** Figma RD01b: block details float over the canvas; selection never answers or settles attention. */
function BlockDetails({
  run,
  block,
  observationUnavailable,
  onClose,
  onUpdated,
}: {
  run: RunDetail;
  block: FlowBlock;
  observationUnavailable: boolean;
  onClose: () => void;
  onUpdated: (run: RunDetail) => void;
}) {
  const recorded = run.blocks.find((item) => item.blockId === block.id);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, [block.id]);
  if (!recorded) return null;
  const visits = blockVisits(run, block);
  const latest = visits[visits.length - 1];
  const KindIcon = block.kind === "human" ? User : Bot;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Block details"
      className="absolute top-3 right-3 bottom-3 z-20 flex w-85 max-w-[calc(100%-1.5rem)] flex-col rounded-xl border bg-card shadow-panel outline-none"
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
          onUpdated={onUpdated}
        />
        {recorded.state === "working" && recorded.workingMessage && (
          <DetailSection title="Working report">
            <div className="flex flex-col gap-3 px-2">
              <p className="text-sm break-words whitespace-pre-wrap text-foreground">
                {recorded.workingMessage}
              </p>
              <RequestReport
                run={run}
                blockId={block.id}
                executionId={recorded.executionId}
                recovery={pendingRecovery(run, recorded)}
                onUpdated={onUpdated}
              />
            </div>
          </DetailSection>
        )}
        <CoordinatorActivations run={run} blockId={block.id} />
        <DetailSection title="Execution">
          <dl className="flex flex-col gap-2">
            <DetailRow label="Visits">{visits.length}</DetailRow>
            <DetailRow label="Current">
              {latest
                ? `visit ${visits.length}${latest.start ? ` · since ${clockTime(latest.start)}` : ""}`
                : "Not visited"}
            </DetailRow>
            <DetailRow label="Attention">{blockAttentionLabel(run, block.id)}</DetailRow>
            <DetailRow label="Observation">
              {observationUnavailable ? "stale" : recorded.freshness}
              {recorded.observedAt ? ` · ${dayAndTime(recorded.observedAt)}` : ""}
            </DetailRow>
          </dl>
        </DetailSection>
        {visits.length > 0 && (
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
                    <StatePill state={visit.status} />
                  </li>
                ))}
            </ul>
          </DetailSection>
        )}
        <DetailSection title="Exits in captured revision">
          <ul className="flex flex-col gap-1.5 px-2">
            {block.exits.map((exit) => {
              const recipients = exitRecipients(run.definitions.flow.graph, block.id, exit.id);
              return (
                <li key={exit.id} className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{exit.name || "Unnamed exit"}</span>
                  <span className="shrink-0 text-2xs tracking-label text-subtle-foreground">
                    {recipients.length ? `→ ${recipients.join(", ")}` : "ends branch"}
                  </span>
                </li>
              );
            })}
          </ul>
        </DetailSection>
        <DetailSection title="T3 references">
          <p className="px-2 font-mono text-2xs leading-4 break-all text-muted-foreground">
            Thread: {recorded.threadId ?? "unresolved"}
            <br />
            Exact execution: {recorded.executionId ?? "unresolved"}
          </p>
        </DetailSection>
      </div>
      <footer className="mx-4 flex items-center gap-3 border-t py-4">
        {recorded.link ? (
          <a
            className="inline-flex h-8 shrink-0 items-center rounded-md border bg-background px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            href={recorded.link}
            target="_blank"
            rel="noreferrer"
          >
            Open thread in T3
          </a>
        ) : (
          <span className="shrink-0 text-2xs tracking-label text-subtle-foreground">
            No T3 thread yet
          </span>
        )}
        <p className="text-2xs tracking-label text-subtle-foreground">
          Selecting never answers or clears attention
        </p>
      </footer>
    </aside>
  );
}

/** Run context rail (Figma A03 inspector): attention, Stop and closure, prompt, Flow revision, project. */
function RunContext({
  run,
  observed,
  stop,
  observationUnavailable,
}: {
  run: RunDetail;
  observed: RunObservation;
  stop: StopControl;
  observationUnavailable: boolean;
}) {
  const unavailable = projectIsUnavailable(observed.project, observed.projectsLoaded);
  return (
    <aside
      aria-label="Run context"
      className="flex w-80 shrink-0 flex-col gap-6 overflow-auto border-l bg-background px-5 py-5"
    >
      <RunAttentionDetails
        run={run}
        observationUnavailable={observationUnavailable}
        onUpdated={observed.setRun}
      />
      <RootWork run={run} />
      <CoordinatorActivations run={run} />
      <PendingIntents run={run} />
      {run.closure ? (
        <ClosureEvidence run={run} closure={run.closure} />
      ) : (
        <StopStatus run={run} stop={stop} />
      )}
      <ContextSection title="Initial prompt" label="Run input">
        <pre className="font-mono text-xs leading-4.5 break-words whitespace-pre-wrap text-emphasis-foreground">
          {run.input}
        </pre>
      </ContextSection>
      <ContextSection title="Flow revision">
        <p className="text-sm text-emphasis-foreground">
          {run.definitions.flow.name} — captured at Start. Later Flow edits do not change this Run.
        </p>
      </ContextSection>
      <ContextSection title="Project">
        <p className="text-sm text-emphasis-foreground">
          {observed.project?.title ?? "Project"}
          {unavailable ? " — unavailable in T3. History stays readable." : ""}
        </p>
      </ContextSection>
      <WorkPeriods run={run} />
    </aside>
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

function StopStatus({ run, stop }: { run: RunDetail; stop: StopControl }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Stop status">
      {run.stopRequestedAt ? (
        <>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <CircleStop aria-hidden className="size-3.5 text-status-stopped" />
            Stop requested
          </h2>
          <p className={railTextClass}>
            Requested {new Date(run.stopRequestedAt).toLocaleString()}. Factory handoffs are
            blocked.
          </p>
          <p className={railTextClass}>
            Stop includes all owned conversations, related descendants and queued work. Parent
            termination alone cannot confirm Stop. Unavailable descendant evidence keeps this Run
            open.
          </p>
          <p role="status" className="text-2xs leading-4 tracking-label text-attention">
            Uncertain Stop: active, queued or unknown work still needs fresh confirmation. This Run
            stays open. Reconciliation continues automatically after restart.
          </p>
        </>
      ) : (
        <h2 className={sectionLabelClass}>Stop</h2>
      )}
      <p className={railTextClass}>
        Factory Run remains open. T3 execution completion alone is not successful Factory
        completion. Stop does not roll back edits or prevent future direct T3 chats. Closing Factory
        leaves T3 work running.
      </p>
      {stop.error && (
        <Alert variant="destructive">
          <AlertDescription>{stop.error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function ClosureEvidence({
  run,
  closure,
}: {
  run: RunDetail;
  closure: NonNullable<RunDetail["closure"]>;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label="Closure evidence">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <CircleStop aria-hidden className="size-3.5 text-status-stopped" />
        Stopped
      </h2>
      <p className="text-sm text-emphasis-foreground">
        Closed {new Date(closure.confirmedAt).toLocaleString()} · Run elapsed{" "}
        {elapsedSeconds(run.startedAt, closure.confirmedAt)} s
      </p>
      <p className={railTextClass}>
        Recorded worker threads: each was finished in T3 when Factory recorded closure. T3 reads are
        separate; direct work can arrive between those reads and closure. This Run stays permanently
        closed and its timeline ends here, even if its T3 conversations continue. Completion does
        not certify result quality or a shared reviewed repository revision.
      </p>
      {closure.frontier.map((frontier) => (
        <article
          className="flex flex-col gap-1 rounded-md border bg-muted p-3 text-2xs leading-4 tracking-label text-muted-foreground"
          key={JSON.stringify([frontier.environmentId, frontier.threadId])}
        >
          <h3 className="text-sm font-medium tracking-normal text-foreground">
            {blockName(run, frontier.blockId) ?? frontier.blockId}
          </h3>
          <p>
            Environment: {frontier.environmentId} · Thread: {frontier.threadId} · Active execution:{" "}
            {frontier.activeRunId ?? "none"}
          </p>
          <p>Executions observed {new Date(frontier.executionObservedAt).toLocaleString()}</p>
          <ul className="flex flex-col gap-1">
            {frontier.executions.map((execution) => (
              <li key={execution.executionId} className="flex flex-wrap items-center gap-1">
                {execution.executionId} · <StatePill state={execution.status} />
                {execution.sourceAt && (
                  <> · T3 time {new Date(execution.sourceAt).toLocaleString()}</>
                )}
              </li>
            ))}
          </ul>
          <p>
            Native requests: {frontier.pendingRequestCount} · observed{" "}
            {new Date(frontier.nativeObservedAt).toLocaleString()}
          </p>
        </article>
      ))}
    </section>
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
