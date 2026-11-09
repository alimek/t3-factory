import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

/** Run/NumberPill: the global Run number shared with worker thread titles and branches. */
export function RunNumber({
  number,
  className,
  ...props
}: { number: number | null } & ComponentProps<"span">) {
  if (number === null) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border bg-accent px-1 py-px text-2xs leading-3 font-medium whitespace-nowrap text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    >
      #{number}
    </span>
  );
}
