import type { ReactNode } from "react";
import { Bot, TextCursorInput, User } from "lucide-react";
import type { EffectiveExit } from "@t3-factory/domain-validation";

const EXIT_SOURCE_LABELS: Record<EffectiveExit["source"], string> = {
  agent: "Agent",
  local: "local",
  human: "fixed",
};

/** Where an exit comes from, and whether finishing on it needs a message. */
export function exitSourceLabel(exit: EffectiveExit) {
  const source = EXIT_SOURCE_LABELS[exit.source];
  return exit.messageRequired ? `${source} · message` : source;
}

/** The content of an authoring block's header and title rows: kind, name and what it runs. */
export function blockIdentity({
  human,
  name,
  label,
  value,
  trailing,
}: {
  human: boolean;
  name: string;
  label: string;
  value: string;
  trailing?: ReactNode;
}) {
  return {
    header: (
      <span className="flex flex-1 items-center gap-1.5 pt-1.5 pr-2 pl-3">
        {human ? (
          <User aria-hidden className="size-3 text-muted-foreground" />
        ) : (
          <Bot aria-hidden className="size-3 text-link" />
        )}
        <span className="text-2xs font-semibold tracking-section text-muted-foreground">
          {human ? "HUMAN STEP" : "AGENT"}
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
