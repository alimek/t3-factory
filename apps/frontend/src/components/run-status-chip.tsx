import { BellRing, Lock, MessageCircleQuestionMark, TriangleAlert } from "lucide-react";
import { cn } from "../lib/utils.ts";

const chips = {
  woke: { Icon: BellRing, label: "Woke", className: "bg-attention/14 text-attention" },
  "needs-input": {
    Icon: MessageCircleQuestionMark,
    label: "Needs input",
    className: "bg-status-waiting/16 text-status-waiting",
  },
  problem: {
    Icon: TriangleAlert,
    label: "Problem",
    className: "bg-destructive/14 text-destructive",
  },
  "project-unavailable": {
    Icon: Lock,
    label: "Project unavailable",
    className: "border border-border bg-accent text-muted-foreground",
  },
} as const;

/**
 * Run/StatusChip: attention and context markers on a Run row. Always an icon plus
 * a label, so meaning never depends on color alone.
 */
export function RunStatusChip({ kind }: { kind: keyof typeof chips }) {
  const { Icon, label, className } = chips[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm py-0.5 pr-1.5 pl-[5px] text-2xs leading-tight font-medium whitespace-nowrap",
        className,
      )}
    >
      <Icon aria-hidden strokeWidth={2} className="size-[11px]" />
      {label}
    </span>
  );
}
