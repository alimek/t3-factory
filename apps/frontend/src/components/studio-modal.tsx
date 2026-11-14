import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, Workflow } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  useStudioNavigation,
  useStudioOptions,
  type StudioSelection,
} from "../settings-navigation.ts";
import { FlowList } from "../routes/flows.tsx";
import { FlowDetail } from "../routes/flow-editor.tsx";
import { StudioAgentsPage } from "../routes/agents.tsx";
import { CreateFlow } from "./create-flow.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { WorkspaceDialogHeader } from "./workspace-dialog-header.tsx";
import { cn } from "@/lib/utils";
import { type StudioDraft, useStudioDraftGuard } from "../use-studio-draft-guard.ts";
import { useServerWatchesDefinitions } from "../client-scope.ts";
import type { Retained } from "../draft-guard.ts";
import { useLiveDefinitions } from "../live/live-connection.ts";
import {
  createStudioDefinitions,
  useStudioRead,
  type StudioDefinitions,
} from "../studio-definitions.ts";

/**
 * This Studio session's saved definitions, read again after each Studio navigation. The session
 * ends a moment after Studio closes, so StrictMode's immediate remount keeps the same session.
 */
function useStudioSession(selection: StudioSelection) {
  const live = useServerWatchesDefinitions();
  const [definitions] = useState(() =>
    createStudioDefinitions(undefined, live ? "live" : "manual"),
  );
  const ending = useRef<number>(undefined);
  useEffect(() => {
    window.clearTimeout(ending.current);
    return () => {
      ending.current = window.setTimeout(definitions.dispose, 0);
    };
  }, [definitions]);
  const shown = useRef(selection);
  // Before paint, so a new page never shows the previous page's read as its own.
  useLayoutEffect(() => {
    if (shown.current === selection) return;
    shown.current = selection;
    definitions.refresh();
  }, [definitions, selection]);
  return definitions;
}

/**
 * Feeds a live source from live delivery while Studio is open, so changes made by any client,
 * such as Factory MCP, appear at once. An older server cannot deliver them: Studio says so.
 */
function FollowDefinitions({ definitions }: { definitions: StudioDefinitions }) {
  return definitions.source === "live" ? (
    <FollowLiveDefinitions definitions={definitions} />
  ) : (
    <p
      role="status"
      className="shrink-0 border-b border-attention/40 bg-attention/8 px-4 py-2 text-sm text-foreground"
    >
      Live Studio refresh requires a server update. Changes made elsewhere appear after you navigate
      or try again.
    </p>
  );
}

function FollowLiveDefinitions({ definitions }: { definitions: StudioDefinitions }) {
  const view = useLiveDefinitions();
  useEffect(() => {
    definitions.receive(view);
  }, [definitions, view]);
  return null;
}

/** The Escape handler an open Studio page registers; Studio runs it instead of closing. */
function useEscapeHandler() {
  const escapeHandler = useRef<(() => void) | null>(null);
  const registerEscape = useCallback((handler: () => void) => {
    escapeHandler.current = handler;
    return () => {
      if (escapeHandler.current === handler) escapeHandler.current = null;
    };
  }, []);
  return { escapeHandler, registerEscape };
}

export function StudioModal({ selection }: { selection: StudioSelection }) {
  const navigate = useStudioNavigation();
  const definitions = useStudioSession(selection);
  const dialog = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [flowDraft, setFlowDraft] = useState<StudioDraft>();
  const [agentDraft, setAgentDraft] = useState<StudioDraft>();
  const flowDraftRef = useRef<StudioDraft | undefined>(undefined);
  const agentDraftRef = useRef<StudioDraft | undefined>(undefined);
  const reportFlowDraft = useCallback((id: string, retained: Retained) => {
    if (!retained && flowDraftRef.current?.id !== id) return;
    const next = retained ? ({ kind: "flow", id, retained } as const) : undefined;
    flowDraftRef.current = next;
    setFlowDraft(next);
  }, []);
  const reportAgentDraft = useCallback((id: string, retained: Retained) => {
    if (!retained && agentDraftRef.current?.id !== id) return;
    const next = retained ? ({ kind: "agent", id, retained } as const) : undefined;
    agentDraftRef.current = next;
    setAgentDraft(next);
  }, []);
  const blocker = useStudioDraftGuard({
    flow: flowDraft,
    agent: agentDraft,
    flowRef: flowDraftRef,
    agentRef: agentDraftRef,
  });
  const { escapeHandler, registerEscape } = useEscapeHandler();
  const close = () => void navigate(undefined);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !creating && blocker.status !== "blocked") close();
      }}
    >
      <DialogContent
        data-studio="true"
        presentation="workspace"
        showCloseButton={false}
        ref={dialog}
        className="inset-4 flex h-auto min-h-0 w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden bg-muted p-0 max-sm:inset-2 sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialog.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (creating || blocker.status === "blocked") {
            event.preventDefault();
            return;
          }
          if (escapeHandler.current) {
            event.preventDefault();
            escapeHandler.current();
          }
        }}
      >
        <WorkspaceDialogHeader
          title="Studio"
          section={selection.tab === "agents" ? "Agents" : "Flows"}
          description="Author global Flows and reusable Agent definitions."
          onClose={close}
          closeLabel="Back to Runs"
          closeDisabled={creating}
        />
        <FollowDefinitions definitions={definitions} />
        <div className="flex min-h-0 flex-1">
          <StudioSidebar selection={selection} definitions={definitions} />
          <StudioContent
            selection={selection}
            definitions={definitions}
            registerEscape={registerEscape}
            reportFlowDraft={reportFlowDraft}
            reportAgentDraft={reportAgentDraft}
            onCreate={() => setCreating(true)}
          />
        </div>
        {blocker.status === "blocked" && (
          <DraftDiscardDialog blocker={blocker} selection={selection} />
        )}
        {creating && (
          <CreateFlow
            createFlow={definitions.createFlow}
            onClose={() => setCreating(false)}
            onCreated={(flow) => {
              setCreating(false);
              void navigate({ tab: "flows", flowId: flow.id });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const draftNoun = (draft: StudioDraft) => (draft.kind === "flow" ? "Flow" : "Agent");

/** The discard question for the drafts a navigation would leave. */
function discardQuestion(drafts: readonly StudioDraft[]) {
  if (drafts.length > 1)
    return {
      title: "Discard the retained Flow and Agent drafts?",
      description: drafts
        .map((draft) =>
          draft.retained === "removed"
            ? `This ${draftNoun(draft)} was removed elsewhere; only your retained draft is left.`
            : `Your ${draftNoun(draft)} has unsaved changes.`,
        )
        .join(" "),
    };
  const [draft] = drafts;
  const noun = draftNoun(draft!);
  return draft!.retained === "removed"
    ? {
        title: `This ${noun} was removed elsewhere. Discard the retained draft?`,
        description: `Keep editing to copy the draft as JSON first, or discard it to continue.`,
      }
    : {
        title: `Discard unsaved ${noun} changes?`,
        description: `This ${noun} has unsaved changes. Keep editing to save them, or discard them to continue.`,
      };
}

function DraftDiscardDialog({
  blocker,
  selection,
}: {
  blocker: Extract<ReturnType<typeof useStudioDraftGuard>, { status: "blocked" }>;
  selection: StudioSelection;
}) {
  const navigate = useStudioNavigation();
  const question = discardQuestion(blocker.drafts);
  const hiddenFlow = blocker.drafts.find(
    (draft) =>
      draft.kind === "flow" && !(selection.tab === "flows" && selection.flowId === draft.id),
  );
  function keepEditing() {
    blocker.reset();
    // A Flow draft retained behind another page opens so its owner can act on it.
    if (hiddenFlow) void navigate({ tab: "flows", flowId: hiddenFlow.id });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) blocker.reset();
      }}
    >
      <DialogContent
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            blocker.reset();
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          blocker.reset();
        }}
      >
        <DialogTitle>{question.title}</DialogTitle>
        <DialogDescription>{question.description}</DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={keepEditing}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={blocker.proceed}>
            {blocker.drafts.some((draft) => draft.retained === "removed")
              ? "Discard"
              : "Discard changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StudioSidebar({
  selection,
  definitions,
}: {
  selection: StudioSelection;
  definitions: StudioDefinitions;
}) {
  const flowsOptions = useStudioOptions({ tab: "flows" });
  const agentsOptions = useStudioOptions({ tab: "agents" });
  const flows = useStudioRead(definitions, "flows").value;
  const agents = useStudioRead(definitions, "agents").value;
  return (
    <aside className="flex w-48 shrink-0 flex-col border-r bg-sidebar max-sm:w-36">
      <nav aria-label="Studio navigation" className="grid gap-0.5 px-3 pt-3">
        <p className="px-3 pb-1 text-2xs font-semibold tracking-section text-subtle-foreground">
          AUTHOR
        </p>
        <Link
          {...flowsOptions}
          aria-label="Flows"
          aria-current={selection.tab === "flows" ? "page" : undefined}
          className={cn(
            "flex h-8.5 items-center gap-2 rounded-md px-3 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            selection.tab === "flows"
              ? "bg-sidebar-accent font-medium text-foreground"
              : "text-muted-foreground",
          )}
        >
          <Workflow aria-hidden className="size-4" strokeWidth={1.5} />
          Flows
          <span aria-hidden className="ml-auto text-2xs font-medium text-subtle-foreground">
            {flows?.length}
          </span>
        </Link>
        <Link
          {...agentsOptions}
          aria-label="Agents"
          aria-current={selection.tab === "agents" ? "page" : undefined}
          className={cn(
            "flex h-8.5 items-center gap-2 rounded-md px-3 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            selection.tab === "agents"
              ? "bg-sidebar-accent font-medium text-foreground"
              : "text-muted-foreground",
          )}
        >
          <Bot aria-hidden className="size-4" strokeWidth={1.5} />
          Agents
          <span aria-hidden className="ml-auto text-2xs font-medium text-subtle-foreground">
            {agents?.length}
          </span>
        </Link>
      </nav>
    </aside>
  );
}

function StudioContent({
  selection,
  definitions,
  registerEscape,
  onCreate,
  reportFlowDraft,
  reportAgentDraft,
}: {
  selection: StudioSelection;
  definitions: StudioDefinitions;
  registerEscape: (handler: () => void) => () => void;
  onCreate: () => void;
  reportFlowDraft: (id: string, retained: Retained) => void;
  reportAgentDraft: (id: string, retained: Retained) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      (focused.closest("[inert]") || focused === document.body)
    ) {
      content.current?.focus();
    }
  }, [selection]);
  const flowId = selection.tab === "flows" ? selection.flowId : undefined;
  const agentId = selection.tab === "agents" ? selection.agentId : undefined;
  // Keep the current Flow mounted across library and Agent navigation, including its local draft.
  const [openedFlowId, setOpenedFlowId] = useState(flowId);
  if (flowId && openedFlowId !== flowId) setOpenedFlowId(flowId);
  const flowHidden = selection.tab === "agents" || flowId !== openedFlowId;
  return (
    <div
      ref={content}
      tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none"
    >
      {selection.tab === "agents" ? (
        <StudioAgentsPage
          agentId={agentId}
          definitions={definitions}
          reportAgentDraft={reportAgentDraft}
        />
      ) : !flowId ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <FlowList definitions={definitions} onCreate={onCreate} />
        </div>
      ) : null}
      {openedFlowId && (
        <div
          key={openedFlowId}
          className={cn(
            selection.tab === "agents" ? "hidden" : "min-h-0 flex-1 overflow-auto",
            flowHidden && "hidden",
          )}
          inert={flowHidden}
        >
          <FlowDetail
            id={openedFlowId}
            definitions={definitions}
            active={!flowHidden}
            registerEscape={registerEscape}
            reportDraft={reportFlowDraft}
          />
        </div>
      )}
    </div>
  );
}
