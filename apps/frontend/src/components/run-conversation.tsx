import type { RunDetail } from "@t3-factory/contracts";
import { CircleHelp, ExternalLink, MessageCircle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "./notice.tsx";

/** Public launch problems can contain protocol details; explain the actionable limit instead. */
function launchProblem(problem: string) {
  if (/authorization context/i.test(problem))
    return "The connection that accepted this Run is unavailable or has changed.";
  if (/payload|target/i.test(problem))
    return "Factory could not verify the saved conversation launch details.";
  return "Factory could not confirm the Run conversation launch.";
}

export function RunConversationNotice({
  coordinator,
}: {
  coordinator: RunDetail["runCoordinator"];
}) {
  if (!coordinator) return null;
  const { state, problem } = coordinator;
  if (state === "acknowledged" && !problem) return null;
  if (state === "acknowledged")
    return (
      <Notice
        tone="attention"
        icon={TriangleAlert}
        title="Run coordination needs attention"
        className="w-140 max-w-full"
      >
        Factory could not confirm some work in this Run. Check the block details and Run history.
      </Notice>
    );
  if (state === "cancelled")
    return (
      <Notice
        tone="neutral"
        icon={MessageCircle}
        title="Run conversation launch cancelled"
        className="w-140 max-w-full"
      >
        This launch was cancelled. The Run’s recorded status determines whether all work has
        stopped.
      </Notice>
    );
  if (state === "uncertain")
    return (
      <Notice
        tone="attention"
        icon={TriangleAlert}
        title="Run conversation launch uncertain"
        className="w-140 max-w-full"
      >
        {launchProblem(problem ?? "")} It may already exist in T3. Check this Run’s history before
        starting another Run.
      </Notice>
    );
  if (problem)
    return (
      <Notice
        tone="attention"
        icon={TriangleAlert}
        title="Run conversation unavailable"
        className="w-140 max-w-full"
      >
        {launchProblem(problem)} The conversation link is not available. Check the T3 connection and
        this Run’s history.
      </Notice>
    );
  return (
    <Notice
      tone="info"
      icon={CircleHelp}
      title="Opening Run conversation"
      className="w-140 max-w-full"
    >
      The Run has been accepted. Its conversation link will appear once T3 confirms the launch.
    </Notice>
  );
}

/** A Run-owned conversation stays primary even while its launch has no confirmed link. */
function preferredLink(run: RunDetail) {
  if (run.runCoordinator) return run.runCoordinator.link;
  const [first] = run.definitions.flow.graph.flowInput.targetBlockIds;
  return (
    run.blocks.find((block) => block.blockId === first)?.link ??
    run.blocks.find((block) => block.link)?.link ??
    null
  );
}

export function RunConversationAction({ run }: { run: RunDetail }) {
  const link = preferredLink(run);
  if (!link) return null;
  if (run.runCoordinator)
    return (
      <Button asChild>
        <a href={link} target="_blank" rel="noreferrer">
          Open Run conversation
          <ExternalLink aria-hidden className="size-3" strokeWidth={1.75} />
        </a>
      </Button>
    );
  return (
    <a
      className="inline-flex items-center gap-1 rounded-sm text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      href={link}
      target="_blank"
      rel="noreferrer"
    >
      Open in T3
      <ExternalLink aria-hidden className="size-3" strokeWidth={1.75} />
    </a>
  );
}
