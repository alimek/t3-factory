import type { ReactNode } from "react";
import { Bot, TextCursorInput, User } from "lucide-react";
import type { FlowGraph, FlowInputBlock } from "@t3-factory/contracts";
import type { EffectiveExit } from "@t3-factory/domain-validation";
import { cn } from "@/lib/utils";
import { FLOW_INPUT_WIDTH } from "../flow-geometry.ts";
import { exitRecipients, type CanvasBlock } from "../flow-graph.ts";
import { exitSourceLabel } from "./flow-wires.tsx";

/** Shared block header: kind, name and the referenced Agent or person. */
export function BlockIdentity({
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
  return (
    <>
      <span className="flex h-7.5 w-full items-center gap-1.5 pt-1.5 pr-2 pl-3">
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
      <span className="flex h-11 w-full flex-col gap-1 px-3 pt-0.5">
        <span className="truncate text-sm font-semibold text-foreground">{name}</span>
        <span className="flex min-w-0 gap-1.5 text-2xs tracking-label">
          <span className="text-muted-foreground">{label}</span>
          <span className="truncate text-emphasis-foreground">{value}</span>
        </span>
      </span>
    </>
  );
}

/**
 * The block's exits, each marked Agent, local or fixed and with its output port on the block's
 * right edge. The screen-reader prefix names the connection; it does not mark traversal.
 */
export function BlockExits({
  graph,
  block,
  connectionPrefix = "→",
  port,
}: {
  graph: FlowGraph;
  block: CanvasBlock;
  connectionPrefix?: string;
  port: (exit: EffectiveExit) => ReactNode;
}) {
  return (
    <ul className="pt-1 pb-1.5">
      {block.exits.map((exit) => {
        const recipients = exitRecipients(graph, block.id, exit.id).join(", ");
        return (
          <li key={exit.id} className="relative flex h-6 items-center gap-1.5 pr-3.5 pl-3">
            <span className="truncate text-2xs tracking-label text-muted-foreground">
              {exit.unavailable ? `Agent · ${exit.unavailable}` : exitSourceLabel(exit)}
            </span>
            <span className="flex-1" />
            <span
              className={cn(
                "truncate font-mono text-xs font-medium text-foreground",
                exit.unavailable && "text-attention line-through",
              )}
            >
              {exit.name || "Unnamed exit"}
            </span>
            <span className="sr-only">
              {connectionPrefix} {recipients || "finish here"}
            </span>
            {exit.unavailable ? (
              <span
                aria-hidden
                className="absolute -right-1.5 size-3 rounded-full border-[1.5px] border-attention bg-background"
              />
            ) : (
              port(exit)
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The block's input port; `highlighted` marks it as the target of a connection being drawn. */
export function BlockInputPort({
  highlighted = false,
  graphY,
}: {
  highlighted?: boolean;
  /** Anchor y in graph coordinates (block top = 0). */
  graphY: number;
}) {
  const top = highlighted ? graphY - 8 : graphY - 6;
  return (
    <span
      aria-hidden
      data-incoming-port
      data-graph-y={graphY}
      style={{ top }}
      className={cn(
        "absolute -left-1.5 size-3 rounded-full border-[1.5px] border-muted-foreground bg-background transition-[width,height,top,left]",
        highlighted && "-left-2 size-4 border-2 border-primary ring-4 ring-primary/25",
      )}
    />
  );
}

/**
 * The Flow input block's card at its canvas position. It has no input port and no exits;
 * the canvas supplies its header (`children`) and its single output port.
 */
export function FlowInputNode({
  flowInput,
  className,
  children,
}: {
  flowInput: FlowInputBlock;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article
      aria-label="Flow input block"
      data-flow-input
      className={cn(
        "absolute flex flex-col rounded-lg border border-brand-soft-border bg-card",
        className,
      )}
      style={{ left: flowInput.position.x, top: flowInput.position.y, width: FLOW_INPUT_WIDTH }}
    >
      {children}
    </article>
  );
}

/**
 * The Flow input block's header: kind, title and what it carries. `detail` shows a
 * particular Run's prompt below it.
 */
export function FlowInputIdentity({
  detail,
  trailing,
}: {
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      <span className="flex h-7.5 w-full items-center gap-1.5 pt-1.5 pr-2 pl-3">
        <TextCursorInput aria-hidden className="size-3 text-link" />
        <span className="text-2xs font-semibold tracking-section text-muted-foreground">
          FLOW INPUT
        </span>
        <span className="flex-1" />
        {trailing}
      </span>
      <span className="flex h-11 w-full flex-col gap-1 px-3 pt-0.5">
        <span className="truncate text-sm font-semibold text-foreground">Flow input</span>
        <span className="truncate text-2xs tracking-label text-muted-foreground">Run prompt</span>
      </span>
      {detail}
    </>
  );
}
