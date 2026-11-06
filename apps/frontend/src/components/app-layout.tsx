import { Outlet, useLocation } from "@tanstack/react-router";
import { RunSidebar } from "./run-sidebar.tsx";
import { SidebarFooter } from "./sidebar-footer.tsx";
import { SettingsModal } from "./settings-modal.tsx";
import { Page, PageHeader } from "./page.tsx";
import { StudioModal } from "./studio-modal.tsx";
import { useStudio, useSettings } from "../settings-navigation.ts";
import { KeyboardCommandsProvider } from "../keyboard-commands.tsx";
import { DesktopTitlebar } from "./desktop-titlebar.tsx";

function AppShell() {
  const path = useLocation({ select: (location) => location.pathname });
  const studio = useStudio();
  const settings = useSettings();
  const backgroundInert = !!studio || !!settings;
  return (
    <div className="flex h-dvh">
      <aside className="flex w-70 shrink-0 flex-col min-h-0 border-r bg-sidebar min-[1280px]:w-75 max-sm:w-56">
        <DesktopTitlebar />
        <RunSidebar path={path} />
        <SidebarFooter />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          data-app-main
          tabIndex={-1}
          inert={backgroundInert}
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <Outlet />
        </div>
      </div>
      {settings && <SettingsModal />}
      {studio && <StudioModal selection={studio} />}
    </div>
  );
}

export function AppLayout() {
  return (
    <KeyboardCommandsProvider>
      <AppShell />
    </KeyboardCommandsProvider>
  );
}

export function NotFoundPage() {
  const path = useLocation({ select: (location) => location.pathname });
  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Page not found"
        description="Choose a page from the navigation."
      />
      <p className="text-sm text-muted-foreground">No route matches {path}.</p>
    </Page>
  );
}
