import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Standard scrolling content area for non-canvas screens. */
export function Page({ className, children, ...props }: ComponentProps<"main">) {
  return (
    <main className={cn("mx-auto w-full max-w-5xl px-8 py-8 max-sm:px-4", className)} {...props}>
      {children}
    </main>
  );
}

/** Per-page top bar (Figma "Top bar", 48 px): page title or breadcrumb, then actions. */
export function PageTopBar({ className, children, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-3 border-b bg-background pr-4 pl-5 text-sm",
        className,
      )}
      {...props}
    >
      {children}
    </header>
  );
}

/** Screen title row: optional eyebrow, the `h1`, a description and trailing actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <SectionLabel className="mb-2">{eyebrow}</SectionLabel>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Figma Text/Section classes, for elements other than a span (such as a field label). */
export const sectionLabelClass =
  "block text-2xs font-semibold tracking-section text-subtle-foreground uppercase";

/** Figma Text/Section: the uppercase group label used in the sidebar, library and panels. */
export function SectionLabel({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn(sectionLabelClass, className)} {...props} />;
}

/** Figma Text/Caption field label (10 px medium, secondary) used by the launch composer and Settings. */
export const fieldLabelClass = "text-2xs leading-none font-medium text-muted-foreground";

/** Figma Run/SelectField box: 40 px, muted surface, icon + value + context + chevrons. */
export const selectFieldClass =
  "flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-muted pr-2.5 pl-3 text-left text-sm font-normal text-foreground transition-[color,background-color,border-color,box-shadow] outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-0 data-[state=open]:border-primary has-[>svg]:pr-2.5 has-[>svg]:pl-3";
