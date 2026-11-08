import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { AppLink as Link } from "./app-link.tsx";
import { Button } from "./ui/button.tsx";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "./ui/context-menu.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.tsx";
import { cn } from "@/lib/utils";

const SidebarRowsContext = createContext<{
  menuOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  now: number;
} | null>(null);

export function SidebarRowsProvider({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return <SidebarRowsContext value={{ menuOpen, setMenuOpen, now }}>{children}</SidebarRowsContext>;
}

export function ActivityAge({ at }: { at: string }) {
  const { now } = useContext(SidebarRowsContext)!;
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  const age =
    minutes < 1
      ? "now"
      : minutes < 60
        ? `${minutes}m`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h`
          : `${Math.floor(minutes / 1440)}d`;
  return (
    <time
      dateTime={at}
      aria-label={`Last activity ${new Date(at).toLocaleString()}`}
      className="shrink-0 text-2xs tabular-nums text-muted-foreground"
    >
      {age}
    </time>
  );
}

function useRowInteractions(disabled: boolean) {
  const { menuOpen, setMenuOpen } = useContext(SidebarRowsContext)!;
  const [ownMenuOpen, setOwnMenuOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [actionsTipOpen, setActionsTipOpen] = useState(false);
  const suppressPreview = useRef(false);
  const row = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const openAtRow = () => {
    if (disabled || !row.current) return;
    const bounds = row.current.getBoundingClientRect();
    row.current.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + 12,
        clientY: bounds.bottom,
      }),
    );
  };
  const dismissPreview = () => {
    suppressPreview.current = true;
    setTipOpen(false);
    setActionsTipOpen(false);
  };
  const enablePreview = () => {
    if (!menuOpen) suppressPreview.current = false;
  };
  return {
    ownMenuOpen,
    openAtRow,
    menu: {
      onOpenChange(open: boolean) {
        setOwnMenuOpen(open);
        setMenuOpen(open);
        dismissPreview();
      },
    },
    trigger: {
      ref: row,
      onContextMenuCapture: dismissPreview,
      onKeyDown(event: KeyboardEvent) {
        if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
          event.preventDefault();
          openAtRow();
        }
      },
    },
    link: { ref: link, onPointerEnter: enablePreview, onBlur: enablePreview },
    tooltip: {
      open: tipOpen && !menuOpen,
      onOpenChange(open: boolean) {
        setTipOpen(open && !menuOpen && !suppressPreview.current);
      },
    },
    actionsTooltip: {
      open: actionsTipOpen && !menuOpen,
      onOpenChange(open: boolean) {
        setActionsTipOpen(open && !menuOpen && !suppressPreview.current);
      },
    },
    content: {
      onCloseAutoFocus(event: Event) {
        event.preventDefault();
        if (!document.querySelector('[role="dialog"]'))
          link.current?.focus({ preventScroll: true });
      },
    },
  };
}

/** One row layout and action surface for Runs and drafts. */
export function SidebarRow({
  id,
  title,
  kind,
  selected,
  compact = false,
  disabled = false,
  onClick,
  preview,
  actions,
  children,
}: {
  id: string;
  title: string;
  kind: "run" | "draft";
  selected: boolean;
  compact?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  preview: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  const interaction = useRowInteractions(disabled);
  const destination =
    kind === "run"
      ? { to: "/runs/$runId" as const, params: { runId: id } }
      : { to: "/runs/new" as const };
  return (
    <ContextMenu {...interaction.menu}>
      <ContextMenuTrigger asChild disabled={disabled}>
        <div
          {...interaction.trigger}
          data-sidebar-row={id}
          className={cn(
            "group/row flex min-w-0 items-start rounded-md hover:bg-accent has-[a:focus-visible]:bg-accent",
            (selected || interaction.ownMenuOpen) && "bg-accent",
            selected && "ring-1 ring-border-strong ring-inset",
          )}
        >
          <Tooltip {...interaction.tooltip}>
            <TooltipTrigger asChild>
              <Link
                {...destination}
                {...interaction.link}
                id={`run-row-${id}`}
                onClick={onClick}
                aria-label={kind === "draft" ? `${title} Draft` : undefined}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 rounded-md px-2.5 text-foreground no-underline hover:no-underline",
                  compact ? "items-center gap-2 py-1.5" : "flex-col gap-1 py-1.5",
                )}
              >
                {children}
              </Link>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              showArrow={false}
              className="max-h-(--radix-tooltip-content-available-height) w-80 max-w-(--radix-tooltip-content-available-width) overflow-auto p-4 text-left text-xs leading-relaxed font-normal text-pretty"
            >
              {preview}
            </TooltipContent>
          </Tooltip>
          <Tooltip {...interaction.actionsTooltip}>
            <TooltipTrigger asChild>
              <Button
                aria-label={`Actions for ${title}`}
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                className="mt-1 mr-1 hidden shrink-0 text-muted-foreground [@media(any-pointer:coarse)]:inline-flex"
                onClick={(event) => {
                  event.preventDefault();
                  interaction.openAtRow();
                }}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run actions</TooltipContent>
          </Tooltip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-50 border-border-strong" {...interaction.content}>
        {actions}
      </ContextMenuContent>
    </ContextMenu>
  );
}
