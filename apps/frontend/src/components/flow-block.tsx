import type { ReactNode } from "react";
import { Bot, Hourglass, TextCursorInput, User, type LucideIcon } from "lucide-react";
import type { FlowBlock } from "@t3-factory/contracts";
import type { EffectiveExit } from "@t3-factory/domain-validation";

const EXIT_SOURCE_LABELS: Record<EffectiveExit["source"], string> = {
  agent: "Agent",
  local: "local",
  human: "fixed",
  wait: "after the wait",
};

/** Each block kind's icon and its names on blocks and in labels. */
export const BLOCK_KINDS: Record<
  FlowBlock["kind"],
  { readonly icon: LucideIcon; readonly header: string; readonly name: string }
> = {
  agent: { icon: Bot, header: "AGENT", name: "Agent" },
  human: { icon: User, header: "HUMAN STEP", name: "Human step" },
  wait: { icon: Hourglass, header: "WAIT", name: "Wait" },
};

/** An exit's name as rows show it; a Wait's single output has none. */
export function exitDisplayName(exit: Pick<EffectiveExit, "name" | "source">) {
  return exit.source === "wait" ? "" : exit.name || "Unnamed exit";
}

/** Where an exit comes from, and whether finishing on it needs a message. */
export function exitSourceLabel(exit: EffectiveExit) {
  const source = EXIT_SOURCE_LABELS[exit.source];
  return exit.messageRequired ? `${source} · message` : source;
}

/** The content of an authoring block's header and title rows: kind, name and what it runs. */
export function blockIdentity({
  kind,
  name,
  label,
  value,
  trailing,
}: {
  kind: FlowBlock["kind"];
  name: string;
  label: string;
  value: string;
  trailing?: ReactNode;
}) {
  const { icon: Icon, header } = BLOCK_KINDS[kind];
  return {
    header: (
      <span className="flex flex-1 items-center gap-1.5 pt-1.5 pr-2 pl-3">
        <Icon
          aria-hidden
          className={kind === "agent" ? "size-3 text-link" : "size-3 text-muted-foreground"}
        />
        <span className="text-2xs font-semibold tracking-section text-muted-foreground">
          {header}
        </span>
        <span className="flex-1" />
        {trailing}
      </span>
    ),
    title: (
      <span className="flex flex-1 flex-col gap-1 px-3 pt-0.5">
        <span className="truncate text-sm font-semibold text-foreground">{name}</span>
        <span className="flex min-w-0 gap-1.5 text-2xs tracking-label">
          <span className="text-muted-foreground">{label}</span>
          <span className="truncate text-emphasis-foreground">{value}</span>
        </span>
      </span>
    ),
  };
}

/** The content of the Flow input block's header and title rows on either canvas. */
export function flowInputIdentity(trailing: ReactNode) {
  return {
    header: (
      <span className="flex flex-1 items-center gap-1.5 pt-1.5 pr-2 pl-3">
        <TextCursorInput aria-hidden className="size-3 text-link" />
        <span className="text-2xs font-semibold tracking-section text-muted-foreground">
          FLOW INPUT
        </span>
        <span className="flex-1" />
        {trailing}
      </span>
    ),
    title: (
      <span className="flex flex-1 flex-col gap-1 px-3 pt-0.5">
        <span className="truncate text-sm font-semibold text-foreground">Flow input</span>
        <span className="truncate text-2xs tracking-label text-muted-foreground">Run prompt</span>
      </span>
    ),
  };
}
