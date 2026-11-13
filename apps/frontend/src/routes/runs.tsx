import { MutationGate } from "@/client-gate";
import { CanvasLayout } from "../components/screen-layout.tsx";
import { RunConversationAction, RunConversationNotice } from "../components/run-conversation.tsx";
import { RunSettlementSection } from "../components/settle-run.tsx";
import { RunInspector } from "../components/run-inspector.tsx";
import { useSettings, useStudio } from "../settings-navigation.ts";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FactoryProject, RunDetail } from "@t3-factory/contracts";
import {
  Archive,
  CircleCheck,
  CircleHelp,
  Lock,
  PanelRight,
  TriangleAlert,
  Unplug,
  Workflow,
} from "lucide-react";
import { RunAttentionDetails } from "../components/run-attention.tsx";
import { ArchiveRunDialog } from "../components/archive-run-dialog.tsx";
import { RunNumber } from "../components/run-number.tsx";
import { RunTimeline } from "../components/run-timeline.tsx";
import { ExecutionCanvas } from "../components/execution-canvas.tsx";
import { clockTime, dayAndTime, StatePill } from "../components/execution-state.tsx";
import { Notice, NoticeSettingsLink } from "../components/notice.tsx";
import { useConnectionState } from "../connection-state.tsx";
import { OpenRunKeyboardHost } from "../open-run-keyboard.tsx";
import { useLiveNavigation } from "../live/navigation.ts";
import { useRunInspectorOpen, toggleRunInspector } from "../run-inspector-preference.ts";
import { useShortcutPreferences } from "../shortcut-preferences.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "../api.ts";
import { useProjects } from "../use-projects.ts";
import { useLiveRun } from "../live/run.ts";
import { useLiveDelivery } from "../transport.ts";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CurrentFlowRevision = { readonly revision: number } | "missing";

/** Run detail is live; descriptive catalogs are read once for this screen entry. */
function useRunObservation(id: string) {
  const { value: run, error: scopeError, synchronized } = useLiveRun(id);
  const delivery = useLiveDelivery();
  const catalog = useProjects(id);
  const [definition, setDefinition] = useState<CurrentFlowRevision>();
  const flowId = run?.flowId;
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

export function RunScreen({ id }: { id: string }) {
  const observed = useRunObservation(id);
  const { value: runs } = useLiveNavigation();
  const navigationRun = runs?.find((run) => run.id === id);
  const [selected, setSelected] = useState<string | null>(null);
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
          onSelect={setSelected}
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
  onSelect,
}: {
  observed: RunObservation;
  run: RunDetail;
  seenError: string;
  selected: string | null;
  onSelect: (blockId: string | null) => void;
}) {
  const settings = useSettings();
  const studio = useStudio();
  const inspectorOpen = useRunInspectorOpen();
  const unavailable = observed.unavailable;
  return (
    <>
      <RunTopBar run={run} observed={observed} inspectorOpen={inspectorOpen} />
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
          </div>
          {!inspectorOpen && run.attention.some((item) => !item.settledAt) && (
            <div className="max-h-60 shrink-0 overflow-auto border-t px-4 py-3">
              <RunAttentionDetails run={run} observationUnavailable={unavailable} />
            </div>
          )}
          {run.settlement && <RunSettlementSection id={run.id} settlement={run.settlement} />}
          <RunTimeline run={run} selectedBlockId={selected} />
        </div>
        {inspectorOpen && (
          <RunInspector
            run={run}
            selected={selected}
            project={observed.project}
            projectUnavailable={projectIsUnavailable(observed.project, observed.projectsLoaded)}
            observationUnavailable={unavailable}
            onSelect={onSelect}
          />
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
  inspectorOpen,
}: {
  run: RunDetail;
  observed: RunObservation;
  inspectorOpen: boolean;
}) {
  const { project } = observed;
  const unavailable = projectIsUnavailable(project, observed.projectsLoaded);
  const [archiving, setArchiving] = useState(false);
  const { hint } = useShortcutPreferences();
  const archiveHint = hint("archive");
  const inspectorHint = hint("toggleInspector");
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle inspector"
            aria-pressed={inspectorOpen}
            onClick={toggleRunInspector}
          >
            <PanelRight aria-hidden strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {inspectorOpen ? "Hide inspector" : "Show inspector"}
          {inspectorHint !== "Unbound" ? ` · ${inspectorHint}` : ""}
        </TooltipContent>
      </Tooltip>
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
