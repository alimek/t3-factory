import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PageTopBar } from "./page.tsx";

/** Full-height workspace shared by the authoring and execution canvases. */
export function CanvasLayout({ children }: { children: ReactNode }) {
  return <main className="flex h-full min-h-140 flex-col">{children}</main>;
}

/** Scrolling page with the common compact application top bar. */
export function ScreenLayout({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <PageTopBar>{title}</PageTopBar>
      {children}
    </div>
  );
}

export function SettingsPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("h-full min-h-0 overflow-y-auto px-8 pt-6 pb-8", className)}>{children}</div>
  );
}
