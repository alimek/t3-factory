import { MutationGate } from "@/client-gate";
import { ScreenLayout } from "../components/screen-layout.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { FlowDraft, LaunchChoices } from "@t3-factory/contracts";
import { api } from "../api.ts";
import { useConnectionState } from "../connection-state.tsx";
import { useLiveLaunchChoices } from "../live/launch-choices.ts";
import type { LiveScopeView } from "../live/owner.ts";
import { runDraft, useRunDraft } from "../run-draft.ts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronsUpDown,
  CircleHelp,
  Info,
  Play,
  TriangleAlert,
  Unplug,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { ProjectPicker, useProjectCatalog } from "../components/project-picker.tsx";
import {
  Notice,
  NoticeButton,
  NoticeSettingsLink,
  NoticeStudioLink,
} from "../components/notice.tsx";
import { fieldLabelClass, selectFieldClass } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { PickerMenuContent, PickerMenuSearch } from "../components/picker-menu-search.tsx";
import { Label } from "../components/ui/label.tsx";
import {
  AttachImagesButton,
  ImageDropOverlay,
  ImagePreview,
  ImageRejections,
  PromptImageStrip,
  useImageDrop,
} from "../components/prompt-images.tsx";
import { PromptEditor, type PromptEditorHandle } from "../components/prompt-editor.tsx";
import { cn } from "../lib/utils.ts";
import type { ConnectionPresentation } from "../connection-state.tsx";

const connectionNotices: Record<
  Exclude<ConnectionPresentation, "ready">,
  { tone: "critical" | "attention" | "neutral"; icon: LucideIcon; title: string; body: string }
> = {
  loading: {
    tone: "neutral",
    icon: CircleHelp,
    title: "Checking T3 connection…",
    body: "Start is available once Factory confirms T3 is connected.",
  },
  "load-error": {
    tone: "critical",
    icon: TriangleAlert,
    title: "Could not load T3 connection status",
    body: "Your draft is kept. Check that Factory is running, then check the connection again.",
  },
  unavailable: {
    tone: "critical",
    icon: Unplug,
    title: "T3 is disconnected",
    body: "Your draft is kept. Start is available again as soon as Factory reconnects to T3.",
  },
  "authorization-required": {
    tone: "attention",
    icon: TriangleAlert,
    title: "Authorize Factory in T3",
    body: "T3 is running but hasn’t granted this Factory access. Approve it in T3 — your draft stays here.",
  },
  incompatible: {
    tone: "attention",
    icon: TriangleAlert,
    title: "T3 version is incompatible",
    body: "Update T3 and check again. Until then Factory can show history but can’t start Runs.",
  },
};

/** A Flow launches when its captured Agents and graph are ready. */
function flowCanLaunch(flow: FlowDraft) {
  return flow.readiness.ready;
}

function flowLaunchIssues(flow: FlowDraft) {
  return flow.readiness.issues.map((issue) => issue.message).join(" ");
}

/**
 * Clears a selected Project or Flow that the latest current delivery no longer lists. It runs
 * only when a delivery arrives, not when the selection changes: a just-created choice can be
 * selected before the delivery that lists it, and a non-current delivery is never a deletion.
 */
function useForgetUnavailable({ value, synchronized }: LiveScopeView<LaunchChoices>) {
  useEffect(() => {
    if (!value || !synchronized) return;
    runDraft.forgetUnavailable(
      "flowId",
      value.flows.map((flow) => flow.id),
    );
    runDraft.forgetUnavailable(
      "projectId",
      value.catalog.projects.map((project) => project.id),
    );
  }, [value, synchronized]);
}

function useComposer() {
  const navigate = useNavigate();
  const draft = useRunDraft();
  const choices = useLiveLaunchChoices();
  const projects = useProjectCatalog();
  const flows = choices.value?.flows ?? null;
  const error = choices.error ? "Could not load launch choices. Your draft is kept." : "";
  // Start and live observation depend on readiness: keep it current while shown.
  const { presentation } = useConnectionState();
  const initialized = useRef(false);
  useEffect(() => {
    if (!projects.catalog || initialized.current) return;
    initialized.current = true;
    if (!draft.projectId && projects.catalog.selectedProjectId)
      runDraft.edit({ projectId: projects.catalog.selectedProjectId });
  }, [projects.catalog, draft.projectId]);
  useForgetUnavailable(choices);
  const prompt = useRef<PromptEditorHandle>(null);
  const [promptMissing, setPromptMissing] = useState(false);
  const project = projects.catalog?.projects.find((p) => p.id === draft.projectId);
  const flow = flows?.find((f) => f.id === draft.flowId);
  const locked = draft.pending;
  const projectReady = project?.availability === "available";
  const ready =
    choices.synchronized &&
    presentation === "ready" &&
    projectReady &&
    !!flow &&
    flowCanLaunch(flow) &&
    !projects.busy;
  const start = async () => {
    if (!draft.pending) {
      if (!draft.text.trim()) {
        setPromptMissing(true);
        prompt.current?.focus();
        return;
      }
      if (!ready) return;
    }
    const runId = await runDraft.start();
    if (runId) void navigate({ to: "/runs/$runId", params: { runId } });
  };
  return {
    draft,
    projects,
    flows,
    error,
    presentation,
    prompt,
    promptMissing,
    project,
    flow,
    locked,
    projectReady,
    ready,
    edit: runDraft.edit,
    start,
  };
}

type Composer = ReturnType<typeof useComposer>;

function composerHelp({ presentation }: Composer) {
  if (presentation === "unavailable")
    return "Project and Flow lists show their last known values while disconnected.";
  return "Each Agent Block starts in its own worker. Factory keeps the Flow’s routing.";
}

export function RunComposer() {
  const model = useComposer();
  const { draft, project, projectReady, start } = model;
  const inactive = !draft.pending && (!model.ready || !draft.text.trim());
  return (
    <ScreenLayout title="New Run">
      <main className="flex flex-1 items-center justify-center px-6 pt-8 pb-16 max-sm:px-4">
        <form
          className="flex w-full max-w-160 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void start();
            }
          }}
        >
          <div className="grid gap-1.5">
            <h1 className="text-heading font-semibold tracking-heading">
              {projectReady ? `What should we work on in ${project?.title}?` : "Start a new Run"}
            </h1>
            <p className="text-sm text-muted-foreground">
              A Run gives this prompt to each Agent the Flow input connects to, each in a new agent
              thread.
            </p>
          </div>
          <ComposerFields model={model} />
          <ComposerNotices model={model} />
          <div className="flex items-center justify-between gap-3">
            <p className="flex-1 text-2xs tracking-label text-subtle-foreground">
              {composerHelp(model)}
            </p>
            <MutationGate>
              <Button
                type="submit"
                disabled={draft.busy || (!draft.pending && !model.ready && !!draft.text.trim())}
                aria-disabled={inactive}
                className={cn(
                  "group/start h-9 shrink-0 gap-2 pr-3 pl-3.5 font-semibold has-[>svg]:pr-3 has-[>svg]:pl-3.5",
                  inactive &&
                    "bg-accent text-subtle-foreground hover:bg-accent disabled:opacity-100",
                )}
              >
                <Play aria-hidden className="size-3" strokeWidth={2} />
                {draft.busy ? "Starting…" : draft.pending ? "Check same request" : "Start"}
                <kbd
                  aria-hidden
                  className={cn(
                    "rounded-sm px-1 py-px font-sans text-2xs font-medium",
                    inactive ? "bg-foreground/8" : "bg-primary-foreground/14",
                  )}
                >
                  ⌘↵
                </kbd>
              </Button>
            </MutationGate>
          </div>
        </form>
      </main>
    </ScreenLayout>
  );
}

function flowFieldState({ draft, flows, flow }: Composer) {
  const empty = flows?.length === 0;
  const notReady = !!flow && !flowCanLaunch(flow);
  const missing = !!flows && !!draft.flowId && !flow;
  const help = notReady
    ? flowLaunchIssues(flow)
    : empty
      ? "Create a Flow to define which Agents run and how they hand off."
      : "Choose a ready global Flow.";
  return {
    empty,
    notReady,
    invalid: notReady || missing,
    placeholder: empty ? "No Flows yet" : "Choose a Flow",
    value:
      flow?.name ??
      (empty ? undefined : flows && draft.flowId ? "Selected Flow unavailable" : undefined),
    help: flow && flowCanLaunch(flow) ? undefined : help,
  };
}

/** The visible Run/SelectField value row inside the Flow dropdown trigger. */
function FlowFieldValue({
  model,
  value,
  placeholder,
}: {
  model: Composer;
  value?: string;
  placeholder: string;
}) {
  const { flow } = model;
  if (!value) return <span className="truncate text-muted-foreground">{placeholder}</span>;
  return (
    <>
      <span className="min-w-0 truncate font-medium">{value}</span>
      {flow && (
        <span className="min-w-0 truncate text-2xs tracking-label text-subtle-foreground">
          {flowCanLaunch(flow) ? "ready" : "Not ready"}
        </span>
      )}
    </>
  );
}

const flowRadioItemClass =
  "my-0.5 rounded-md py-2 data-[state=checked]:bg-brand-soft data-[state=checked]:ring-1 data-[state=checked]:ring-brand-soft-border data-[state=checked]:ring-inset data-[state=checked]:focus:bg-brand-soft data-[state=checked]:focus-visible:ring-2 data-[state=checked]:focus-visible:ring-ring";

function FlowChoices({
  model,
  busy,
  search,
  listRef,
  onSelect,
}: {
  model: Composer;
  busy: boolean;
  search: string;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (flowId: string) => void;
}) {
  const { draft, flows, flow } = model;
  const state = flowFieldState(model);
  const query = search.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(query);
  const visibleFlows = flows?.filter((f) => matches(f.name)) ?? [];
  const showUnavailable =
    !!flows?.length && !!draft.flowId && !flow && matches("Selected Flow unavailable");
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (positioned.current || !flows) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-state="checked"]')
      ?.scrollIntoView({ block: "nearest" });
    positioned.current = true;
  }, [flows, listRef]);
  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      role="group"
      aria-label="Flows"
    >
      <DropdownMenuRadioGroup value={draft.flowId} onValueChange={onSelect}>
        {showUnavailable && (
          <DropdownMenuRadioItem
            value={draft.flowId}
            indicatorPosition="right"
            disabled={busy}
            aria-label="Selected Flow unavailable"
            className={flowRadioItemClass}
          >
            <span className="truncate text-muted-foreground">Selected Flow unavailable</span>
          </DropdownMenuRadioItem>
        )}
        {!!flows?.length && (
          <DropdownMenuRadioItem value="" indicatorPosition="right" disabled={busy}>
            Choose a Flow
          </DropdownMenuRadioItem>
        )}
        {visibleFlows.map((f) => (
          <DropdownMenuRadioItem
            key={f.id}
            value={f.id}
            data-flow-id={f.id}
            indicatorPosition="right"
            disabled={busy}
            aria-label={`${f.name}${flowCanLaunch(f) ? "" : " · Not ready"}`}
            className={flowRadioItemClass}
          >
            <span className="min-w-0 flex-1 truncate">
              {f.name}
              {flowCanLaunch(f) ? "" : " · Not ready"}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {!flows && (
        <p role="status" className="px-3 py-6 text-sm text-muted-foreground">
          Loading Flows…
        </p>
      )}
      {flows?.length === 0 && (
        <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
          {state.placeholder}
        </p>
      )}
      {!!flows?.length && query && visibleFlows.length === 0 && !showUnavailable && (
        <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
          No matching Flows.
        </p>
      )}
    </div>
  );
}

function FlowField({ model }: { model: Composer }) {
  const { draft, edit, locked, flows } = model;
  const state = flowFieldState(model);
  const busy = locked;
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerLabel = state.value ?? state.placeholder;
  const showSearch = !!flows?.length;
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor="launch-flow" className={fieldLabelClass}>
        Flow
      </Label>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open && !busy);
          if (open) setSearch("");
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            id="launch-flow"
            variant="outline"
            aria-disabled={busy}
            aria-busy={busy}
            aria-label={`Select Flow: ${triggerLabel}`}
            aria-invalid={state.notReady || undefined}
            aria-describedby={state.help ? "launch-flow-help" : undefined}
            className={cn(selectFieldClass, state.invalid && "border-destructive")}
          >
            <Workflow
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.5}
            />
            <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <FlowFieldValue
                model={model}
                placeholder={state.placeholder}
                {...(state.value ? { value: state.value } : {})}
              />
            </span>
            <ChevronsUpDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.5}
            />
          </Button>
        </DropdownMenuTrigger>
        <PickerMenuContent
          className="flex max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-1rem)] min-w-0 flex-col overflow-hidden p-0"
          searchRef={searchRef}
          listRef={listRef}
          searchEnabled={showSearch}
        >
          {showSearch && (
            <PickerMenuSearch
              ariaLabel="Search Flows"
              placeholder="Search by Flow name…"
              value={search}
              onChange={setSearch}
              inputRef={searchRef}
              listRef={listRef}
              firstChoiceSelector="[data-flow-id]"
            />
          )}
          <FlowChoices
            model={model}
            busy={busy}
            search={search}
            listRef={listRef}
            onSelect={(flowId) => {
              if (busy) return;
              setMenuOpen(false);
              if (flowId !== draft.flowId) edit({ flowId });
            }}
          />
        </PickerMenuContent>
      </DropdownMenu>
      {state.help && (
        <p
          id="launch-flow-help"
          className={cn("text-2xs", state.notReady ? "text-destructive" : "text-muted-foreground")}
        >
          {state.help}
        </p>
      )}
    </div>
  );
}

function ComposerFields({ model }: { model: Composer }) {
  const { draft, projects, locked, edit } = model;
  return (
    <>
      {" "}
      <fieldset disabled={locked} className="grid min-w-0 grid-cols-2 gap-3 max-sm:grid-cols-1">
        <ProjectPicker
          state={projects}
          selectedId={draft.projectId}
          onSelect={(projectId) => edit({ projectId })}
          disabled={locked}
        />
        <FlowField model={model} />
      </fieldset>
      <PromptField model={model} />
    </>
  );
}

/** Required prompt text with inline image references; images are pasted, dropped or picked. */
function PromptField({ model }: { model: Composer }) {
  const { draft, locked, edit, prompt, promptMissing } = model;
  const missing = promptMissing && !draft.text.trim();
  const [previewing, setPreviewing] = useState<string>();
  const previewed = draft.images.find((image) => image.imageId === previewing);
  const drop = useImageDrop(!locked, (files) => void prompt.current?.insertImages(files));
  return (
    <div className="grid gap-1.5">
      <Label
        id="launch-prompt-label"
        onClick={() => prompt.current?.focus()}
        className={cn(fieldLabelClass, "gap-1.5")}
      >
        Initial prompt{" "}
        <span className="font-normal tracking-label text-subtle-foreground">Required</span>
      </Label>
      <div
        {...drop.handlers}
        className={cn(
          "relative flex flex-col gap-2 rounded-lg border bg-muted pt-3 pr-3.5 pb-2.5 pl-3.5 transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/15",
          draft.images.length ? "min-h-42" : "h-42",
          missing && "border-destructive focus-within:border-destructive",
        )}
      >
        <PromptEditor
          ref={prompt}
          segments={draft.segments}
          images={draft.images}
          locked={locked}
          invalid={missing}
          labelledBy="launch-prompt-label"
          describedBy="prompt-help"
          placeholder="Describe what this Run should do…"
          onChange={(segments) => edit({ segments })}
          attachImages={runDraft.attachImages}
          onPreview={setPreviewing}
        />
        <PromptImageStrip
          images={draft.images}
          load={runDraft.loadImage}
          locked={locked}
          onPreview={setPreviewing}
          onRemove={runDraft.removeImage}
        />
        <div className="flex items-center gap-2">
          <p id="prompt-help" className="flex-1 text-2xs tracking-label text-subtle-foreground">
            The first text line becomes the Run title; you can rename it later. Paste or drop
            screenshots to reference them.
          </p>
          <AttachImagesButton
            disabled={locked}
            onFiles={(files) => void runDraft.attachImages(files)}
          />
        </div>
        {drop.dragging && <ImageDropOverlay />}
      </div>
      <ImageRejections rejections={draft.imageRejections} />
      {missing && (
        <p role="alert" className="text-2xs text-destructive">
          Enter an initial prompt to start the Run.
        </p>
      )}
      {previewed && (
        <ImagePreview
          image={previewed}
          load={runDraft.loadImage}
          onClose={() => setPreviewing(undefined)}
        />
      )}
    </div>
  );
}

function ProjectNotice({ model }: { model: Composer }) {
  const { project, projects } = model;
  if (project) {
    return (
      <Notice
        tone="attention"
        icon={TriangleAlert}
        title={`“${project.title}” is no longer available`}
      >
        Selected project is unavailable: {project.availability}. Your Flow and prompt are kept —
        choose another available project or restore it in T3 and recheck.
      </Notice>
    );
  }
  const none = projects.catalog?.projects.length === 0;
  return (
    <Notice
      tone="info"
      icon={Info}
      title={none ? "Add a project in T3 first" : "Choose a project"}
      action={
        <MutationGate>
          <NoticeButton
            disabled={projects.busy}
            onClick={() => void projects.act(api.recheckProjects)}
          >
            Refresh projects
          </NoticeButton>
        </MutationGate>
      }
    >
      {none
        ? "Choose an available project once T3 reports one. Factory uses the projects T3 knows about: add a repository in T3 or in the Project picker, then refresh — your prompt is kept."
        : "Choose an available project to start. Your Flow and prompt are kept."}
    </Notice>
  );
}

function FlowNotice({ model }: { model: Composer }) {
  const { flows, flow } = model;
  if (flows?.length === 0) {
    return (
      <Notice
        tone="info"
        icon={Info}
        title="Create your first Flow"
        action={<NoticeStudioLink selection={{ tab: "flows" }}>Go to Flows</NoticeStudioLink>}
      >
        A Run needs a ready Flow. Build one in Flows — your draft is kept while you are away.
      </Notice>
    );
  }
  if (!flow || flowCanLaunch(flow)) return null;
  return (
    <Notice
      tone="attention"
      icon={TriangleAlert}
      title={`“${flow.name}” isn’t ready to run`}
      action={
        <NoticeStudioLink selection={{ tab: "flows", flowId: flow.id }}>
          Open {flow.name} in Flows
        </NoticeStudioLink>
      }
    >
      Fix its readiness issues in the Flow editor, or pick another Flow. Your project and prompt
      stay.
    </Notice>
  );
}

function StartNotice({ model }: { model: Composer }) {
  const { draft, error, start } = model;
  if (draft.error && draft.pending) {
    return (
      <Notice
        tone="neutral"
        icon={CircleHelp}
        title="We couldn’t confirm the start"
        action={
          <MutationGate>
            <NoticeButton disabled={draft.busy} onClick={() => void start()}>
              Check now
            </NoticeButton>
          </MutationGate>
        }
      >
        {draft.error}
      </Notice>
    );
  }
  if (draft.error) {
    return (
      <Notice
        tone="critical"
        icon={TriangleAlert}
        title="Start was not accepted"
        action={
          <div className="flex min-w-0 flex-col gap-2">
            {draft.issues.length > 0 && (
              <ul aria-label="Start blockers" className="list-disc space-y-1 pl-4 text-foreground">
                {draft.issues.map((issue, index) => (
                  <li key={`${issue.path}:${issue.code}:${index}`} className="break-words">
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {draft.remedy === "reporting" && (
              <NoticeSettingsLink selection={{ tab: "runtime" }}>
                Open Settings → Agent reporting
              </NoticeSettingsLink>
            )}
            {(draft.issues.length === 0 ||
              draft.issues.some(
                (issue) =>
                  issue.path.startsWith("agents.") &&
                  !issue.path.split(".").includes("connection") &&
                  issue.code !== "reporting_installation",
              )) && (
              <NoticeStudioLink selection={{ tab: "agents" }}>
                Open Studio → Agents
              </NoticeStudioLink>
            )}
            {draft.issues.some(
              (issue) => issue.path.startsWith("graph.") || issue.path.startsWith("workspace."),
            ) && (
              <NoticeStudioLink selection={{ tab: "flows", flowId: draft.flowId }}>
                Open Studio → Flows
              </NoticeStudioLink>
            )}
            {draft.issues.some(
              (issue) =>
                issue.path.split(".").includes("connection") || issue.code === "project_connection",
            ) && (
              <NoticeSettingsLink selection={{ tab: "connection" }}>
                Open T3 connection settings
              </NoticeSettingsLink>
            )}
          </div>
        }
      >
        {draft.error} Your draft is kept. Fix every listed blocker, then Start again.
      </Notice>
    );
  }
  if (!error) return null;
  return (
    <Notice tone="neutral" icon={CircleHelp} title="Launch choices are out of date">
      {error}
    </Notice>
  );
}

function DraftStorageNotice({ model }: { model: Composer }) {
  const { draft } = model;
  if (!draft.saveFailed || draft.pending) return null;
  return (
    <Notice tone="attention" icon={TriangleAlert} title="This browser can’t save your draft">
      Your prompt and choices stay while this window is open. Allow site storage for Factory in your
      browser settings to keep drafts after a reload.
    </Notice>
  );
}

function ComposerNotices({ model }: { model: Composer }) {
  const { presentation, projectReady } = model;
  if (presentation !== "ready") {
    const notice = connectionNotices[presentation];
    return (
      <>
        <DraftStorageNotice model={model} />
        <Notice
          tone={notice.tone}
          icon={notice.icon}
          title={notice.title}
          action={
            <NoticeSettingsLink selection={{ tab: "connection" }}>
              Open T3 connection settings
            </NoticeSettingsLink>
          }
        >
          {notice.body}
        </Notice>
        <StartNotice model={model} />
      </>
    );
  }
  return (
    <>
      {" "}
      <DraftStorageNotice model={model} />
      {!projectReady && <ProjectNotice model={model} />}
      <FlowNotice model={model} />
      <StartNotice model={model} />
    </>
  );
}
