import { LocalApplicationControls } from "./application-settings.tsx";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DesktopTitlebar } from "./desktop-titlebar.tsx";

/** Full-window state shown before the product is available: role, connection or access. */
export function GateScreen({
  icon: Icon,
  title,
  description,
  children,
  label,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  /** Accessible name of the screen region, also used by journeys. */
  label: string;
}) {
  return (
    <main
      aria-label={label}
      className="flex min-h-dvh items-center justify-center bg-muted px-4 py-10"
    >
      <DesktopTitlebar floating />
      <section className="grid w-full max-w-md gap-5 rounded-lg border bg-background p-6 shadow-sm">
        <div className="grid gap-2">
          <Icon aria-hidden strokeWidth={1.5} className="size-6 text-muted-foreground" />
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
        {children}
        <LocalApplicationControls />
      </section>
    </main>
  );
}
