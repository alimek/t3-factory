import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { router } from "./router.tsx";
import { ConnectionStateProvider } from "./connection-state.tsx";
import { ReportingStateProvider } from "./reporting-state.tsx";
import { ClientGate } from "./client-gate.tsx";
import { DesktopShell } from "./desktop-shell.tsx";
import { desktopBridge } from "./desktop-bridge.ts";
import { startAppearance } from "./appearance.ts";
import { TooltipProvider } from "./components/ui/tooltip";
import { InheritedColors } from "./components/inherited-colors.tsx";
import "./styles.css";

if (desktopBridge()) document.documentElement.dataset.desktop = "true";
startAppearance();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <DesktopShell>
        <ClientGate>
          <InheritedColors />
          <ConnectionStateProvider>
            <ReportingStateProvider>
              <RouterProvider router={router} />
              <TanStackRouterDevtools
                router={router}
                initialIsOpen={false}
                position="bottom-right"
              />
            </ReportingStateProvider>
          </ConnectionStateProvider>
        </ClientGate>
      </DesktopShell>
    </TooltipProvider>
  </React.StrictMode>,
);
