import { useId, type ReactNode } from "react";
import { ChevronRight, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button.tsx";
import { sectionLabelClass } from "./page.tsx";

/**
 * Figma Settings v2 page template: every Settings section is one header followed by groups of
 * row cards and optional disclosures. These blocks are presentational; pages own the data.
 */
export function SettingsPage({
  title,
  description,
  badge,
  hostManaged = false,
  action,
  children,
}: {
  title: string;
  /** One sentence saying what the page controls. */
  description: ReactNode;
  /** A status pill shown after the title. */
  badge?: ReactNode;
  /** Shows the "Managed on the Factory host" chip on clients that cannot change the page. */
  hostManaged?: boolean;
  /** The page's single primary action. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-5">
      <header className="grid gap-1.5">
        <div className="flex min-h-8 flex-wrap items-center gap-2.5">
          <h2 className="text-lg leading-tight font-semibold text-foreground">{title}</h2>
          {badge}
          {hostManaged && (
            <span className="inline-flex items-center gap-1 rounded-full border py-0.5 pr-2 pl-1.5 text-2xs font-medium text-muted-foreground">
              <Lock aria-hidden className="size-3" strokeWidth={1.5} />
              Managed on the Factory host
            </span>
          )}
          {action && <div className="ml-auto flex items-center">{action}</div>}
        </div>
        <p className="text-sm leading-tight text-muted-foreground">{description}</p>
      </header>
      {children}
    </div>
  );
}

/** A labelled card of rows; the label is the group's heading and region name. */
export function SettingsGroup({
  label,
  badge,
  children,
}: {
  label: string;
  /** A status pill shown after the label. */
  badge?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <div className="flex min-h-4.5 items-center gap-2 pl-0.5">
        <h3 id={id} className={sectionLabelClass}>
          {label}
        </h3>
        {badge}
      </div>
      <div className="divide-y overflow-hidden rounded-lg border bg-background">{children}</div>
    </section>
  );
}

/** Element ids of a row's text, for naming and describing its control. */
type SettingsRowText = { title: string; description: string | undefined };

/**
 * A setting: title, optional description and one trailing control. Pass the control as a
 * function to name it by the row's text, as a switch needs (`aria-labelledby={text.title}`).
 */
export function SettingsRow({
  title,
  description,
  control,
}: {
  title?: ReactNode;
  description?: ReactNode;
  control?: ReactNode | ((text: SettingsRowText) => ReactNode);
}) {
  const id = useId();
  const text: SettingsRowText = {
    title: `${id}-title`,
    description: description ? `${id}-description` : undefined,
  };
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="grid min-w-48 flex-1 gap-0.5 text-sm leading-tight">
        {title && (
          <div id={text.title} className="font-medium text-foreground">
            {title}
          </div>
        )}
        {description && (
          <div id={text.description} className="text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {control && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {typeof control === "function" ? control(text) : control}
        </div>
      )}
    </div>
  );
}

/** A read-only fact: label and value, optionally monospaced, copyable or with one action. */
export function SettingsDetailRow({
  label,
  value,
  mono = false,
  copy,
  action,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  /** Text the copy button puts on the clipboard; omit for no copy button. */
  copy?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-4 py-2 text-sm leading-tight">
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn("min-w-0 flex-1 break-words text-foreground", mono && "font-mono text-label")}
      >
        {value}
      </span>
      {copy !== undefined && <CopyButton text={copy} label={`Copy ${label}`} />}
      {action}
    </div>
  );
}

/** Closed-by-default detail such as "How it works" or "Diagnostics", with a one-line hint. */
export function SettingsDisclosure({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="grid gap-3">
      <CollapsibleTrigger className="group flex w-fit flex-wrap items-center gap-x-1.5 rounded-sm text-left text-sm leading-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight
          aria-hidden
          strokeWidth={1.5}
          className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-medium text-muted-foreground">{label}</span>
        {hint && <span className="text-subtle-foreground">{hint}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 pl-5 text-sm text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export type StatusTone = "success" | "attention" | "neutral" | "error" | "info";

const statusVariants = {
  success: "success",
  attention: "attention",
  neutral: "secondary",
  error: "destructive",
  info: "info",
} as const satisfies Record<StatusTone, string>;

/** A state with a dot in its tone; the label carries the meaning, never the color alone. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <Badge variant={statusVariants[tone]} className="gap-1.5 pr-2 pl-1.75">
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </Badge>
  );
}
