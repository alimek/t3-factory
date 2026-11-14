import type { ComponentProps, ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsLink, StudioLink } from "./app-link.tsx";
import { cn } from "@/lib/utils";

type NoticeTone = "critical" | "attention" | "info" | "neutral";

/**
 * Figma launch / connection notice: toned icon, title, body and one follow-up action.
 * The icon and title carry the meaning, so tone never relies on color alone.
 */
export function Notice({
  tone,
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  tone: NoticeTone;
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Alert variant={tone} className={cn("gap-y-1 px-5 py-3.5", className)}>
      <Icon aria-hidden strokeWidth={1.5} />
      <AlertTitle>{title}</AlertTitle>
      {(children || action) && (
        <AlertDescription className="gap-1.5">
          {children && <p className="leading-snug">{children}</p>}
          {action}
        </AlertDescription>
      )}
    </Alert>
  );
}

const actionClass =
  "inline-flex items-center gap-1 rounded-sm font-medium text-link underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Settings link action for a notice, with the trailing chevron from the Figma notices. */
export function NoticeSettingsLink({ children, ...props }: ComponentProps<typeof SettingsLink>) {
  return (
    <SettingsLink {...props} className={actionClass}>
      {children}
      <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.5} />
    </SettingsLink>
  );
}

/** Button action for a notice that acts in place (recheck, retry). */
export function NoticeButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(actionClass, "disabled:opacity-50")}
    >
      {children}
      <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.5} />
    </button>
  );
}

export function NoticeStudioLink({ children, ...props }: ComponentProps<typeof StudioLink>) {
  return (
    <StudioLink {...props} className={actionClass}>
      {children}
      <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.5} />
    </StudioLink>
  );
}

/** A failed read with its explanation and a Retry that reads again. */
export function ReadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        {message}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
