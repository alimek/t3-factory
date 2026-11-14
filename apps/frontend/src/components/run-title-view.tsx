import { useEffect, useRef } from "react";
import type { RunTitleGeneration } from "@t3-factory/contracts";
import { ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailRow, InspectorSection } from "./inspector-section.tsx";
import { TitleMark, TitleStatePill, titleStateLabel } from "./run-title-generation.tsx";

/** A deadline is 30 seconds after Start, so it reads to the second. */
function secondsTime(at: string) {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * The Run title in the docked inspector: how its generation went. It is not a Block selection, so
 * Block timeline rows stay unhighlighted and following is unchanged.
 */
export function RunTitleView({
  generation,
  onBack,
}: {
  generation: RunTitleGeneration;
  onBack: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.focus();
  }, []);
  const { state, reason, threadLink } = generation;
  return (
    <section aria-label="Run title details" className="flex min-h-0 flex-1 flex-col">
      <div
        ref={content}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pt-3 pb-3 outline-none"
      >
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Back to Run overview"
          onClick={onBack}
          className="-ml-1.5 w-fit text-label font-medium"
        >
          <ChevronLeft aria-hidden />
          Overview
          <kbd className="ml-1 font-mono text-overline font-normal text-subtle-foreground">Esc</kbd>
        </Button>
        <header className="flex min-w-0 items-center gap-2">
          <TitleMark className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="truncate text-base leading-4 font-semibold">Run title</h2>
            <p className="truncate text-xs leading-3.5 text-subtle-foreground">
              Beside the Flow · not a Block
            </p>
          </div>
          <TitleStatePill state={state} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close Run title details"
                onClick={onBack}
              >
                <X aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close · Esc</TooltipContent>
          </Tooltip>
        </header>
        <InspectorSection title="Generation">
          <dl className="flex flex-col gap-2 px-2">
            <DetailRow label="State">
              {titleStateLabel(state)}
              {reason && <span className="block text-muted-foreground">{reason}</span>}
            </DetailRow>
            <DetailRow label="Model">{generation.modelLabel}</DetailRow>
            <DetailRow label="Deadline">{secondsTime(generation.deadlineAt)}</DetailRow>
          </dl>
        </InspectorSection>
        <InspectorSection title="Titles">
          <dl className="flex flex-col gap-2 px-2">
            <DetailRow label="Automatic">{generation.automaticTitle}</DetailRow>
            <DetailRow label="Generated">
              {generation.generatedTitle ?? (
                <span className="text-muted-foreground">
                  {state === "pending" ? "not yet" : "none"}
                </span>
              )}
            </DetailRow>
          </dl>
        </InspectorSection>
      </div>
      <footer className="mx-4 flex shrink-0 items-center border-t py-3">
        {threadLink ? (
          <Button asChild variant="outline" className="w-full">
            <a href={threadLink} target="_blank" rel="noreferrer">
              Open title thread in T3
            </a>
          </Button>
        ) : (
          <p className="text-xs text-subtle-foreground">
            {state === "skipped" ? "Nothing was launched" : "No T3 thread known"}
          </p>
        )}
      </footer>
    </section>
  );
}
