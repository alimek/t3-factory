import { Sparkle } from "lucide-react";
import type { RunTitleGeneration, RunTitleGenerationState } from "@t3-factory/contracts";
import { cn } from "@/lib/utils";
import { StatePill } from "./execution-state.tsx";

const STOPPED = {
  pill: "border-status-stopped [&>span]:bg-status-stopped",
  text: "text-subtle-foreground",
};

/**
 * Run title generation is not Flow work: pending uses the working colour, applied success, and
 * every other outcome the neutral stopped colour, never the error colour.
 */
const STATES: Record<
  RunTitleGenerationState,
  { readonly label: string; readonly pill: string; readonly text: string }
> = {
  pending: {
    label: "generating",
    pill: "border-status-working [&>span]:bg-status-working",
    text: "text-status-working",
  },
  applied: {
    label: "applied",
    pill: "border-success [&>span]:bg-success",
    text: "text-foreground",
  },
  dropped: { label: "dropped", ...STOPPED },
  "timed-out": { label: "timed out", ...STOPPED },
  cancelled: { label: "cancelled", ...STOPPED },
  skipped: { label: "skipped", ...STOPPED },
  failed: { label: "failed", ...STOPPED },
};

export const titleStateLabel = (state: RunTitleGenerationState) => STATES[state].label;

/** What the title line says after its state: the applied title, or the outcome's reason. */
export function titleOutcome(generation: RunTitleGeneration) {
  return generation.state === "applied" ? generation.generatedTitle : generation.reason;
}

export function TitleStatePill({ state }: { state: RunTitleGenerationState }) {
  return <StatePill state={STATES[state].label} className={STATES[state].pill} />;
}

/** The Run's ✦ mark: title generation acts for the Run, never as a Block. */
export function TitleMark({ className }: { className?: string }) {
  return <Sparkle aria-hidden strokeWidth={1.75} className={cn("size-3 shrink-0", className)} />;
}

/** Shown next to the Run title only while its generation is pending; nothing stays afterwards. */
export function GeneratingTitle({ generation }: { generation: RunTitleGeneration | null }) {
  if (generation?.state !== "pending") return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium whitespace-nowrap text-subtle-foreground">
      <TitleMark className="text-status-working motion-safe:animate-pulse" />
      Generating title…
    </span>
  );
}

/**
 * The Flow input card's read-only title line: no port, visit or exit. Pressing it inspects the
 * Run title, which selects no Block.
 */
export function FlowInputTitleLine({
  generation,
  inspected,
  onInspect,
}: {
  generation: RunTitleGeneration;
  inspected: boolean;
  onInspect: () => void;
}) {
  const { label, text } = STATES[generation.state];
  const outcome = titleOutcome(generation);
  const pending = generation.state === "pending";
  return (
    <button
      type="button"
      aria-label={`Run title, ${label}${outcome ? ` · ${outcome}` : ""}`}
      aria-pressed={inspected}
      title={outcome ?? undefined}
      onClick={onInspect}
      className={cn(
        "flex h-full min-w-0 items-center gap-1.5 rounded-b-lg px-3 text-left text-2xs tracking-label outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        inspected ? "bg-accent" : "bg-muted",
      )}
    >
      <TitleMark
        className={pending ? "text-status-working motion-safe:animate-pulse" : "text-link"}
      />
      <span className="shrink-0 font-medium text-muted-foreground">Title</span>
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <span className={cn("shrink-0 font-medium", text)}>{label}</span>
      {outcome && (
        <>
          <span aria-hidden className="text-subtle-foreground">
            ·
          </span>
          <span className={cn("min-w-0 truncate", text)}>{outcome}</span>
        </>
      )}
    </button>
  );
}
