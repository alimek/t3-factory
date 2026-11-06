import { LayoutGrid, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Explicit Auto-arrange control with pending and error feedback. */
export function AutoArrangeButton({
  pending,
  disabled,
  onClick,
  className,
}: {
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn("h-8 gap-1.5 rounded-sm pr-3 pl-2.5 text-2xs", className)}
          disabled={disabled || pending}
          aria-busy={pending}
          aria-label="Auto-arrange"
          onClick={onClick}
        >
          {pending ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <LayoutGrid aria-hidden className="size-3.5" strokeWidth={1.5} />
          )}
          {pending ? "Arranging…" : "Auto-arrange"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Layer blocks left-to-right and route wires</TooltipContent>
    </Tooltip>
  );
}

export function AutoArrangeStatus({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss: () => void;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="pointer-events-auto max-w-sm rounded-lg border border-destructive/40 bg-card px-3 py-2 text-2xs text-destructive shadow-floating"
    >
      <p>{error}</p>
      <button type="button" className="mt-1 underline underline-offset-2" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
