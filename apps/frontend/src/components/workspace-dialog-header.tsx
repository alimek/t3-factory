import { X } from "lucide-react";
import { Button } from "./ui/button";
import { DialogDescription, DialogTitle } from "./ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Shared navigation and dismissal for the Settings and Studio workspaces. */
export function WorkspaceDialogHeader({
  title,
  section,
  description,
  onClose,
  closeLabel = "Close",
  closeDisabled = false,
}: {
  title: string;
  section: string;
  description: string;
  onClose: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
}) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b pr-3 pl-5 text-sm">
      <DialogTitle className="text-sm leading-none font-normal text-muted-foreground">
        {title}
      </DialogTitle>
      <span aria-hidden className="text-subtle-foreground">
        /
      </span>
      <span className="truncate font-medium text-foreground">{section}</span>
      <DialogDescription className="sr-only">{description}</DialogDescription>
      <kbd
        aria-hidden
        className="ml-auto rounded-sm border px-1.5 py-0.5 font-sans text-2xs leading-none font-medium text-subtle-foreground"
      >
        Esc
      </kbd>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={closeLabel}
            className="size-7 text-muted-foreground"
            disabled={closeDisabled}
            onClick={onClose}
          >
            <X aria-hidden className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{closeLabel} (Esc)</TooltipContent>
      </Tooltip>
    </header>
  );
}
