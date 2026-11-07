import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  trimPathRight,
} from "@tanstack/react-router";
import { AppLayout, NotFoundPage } from "./components/app-layout.tsx";
import { RunScreen } from "./routes/runs.tsx";
import { RunComposer } from "./routes/run-composer.tsx";
import {
  settingsMask,
  studioMask,
  validateAppSearch,
  type SettingsSelection,
  type StudioSelection,
} from "./settings-navigation.ts";

const rootRoute = createRootRoute({
  validateSearch: validateAppSearch,
  component: AppLayout,
  notFoundComponent: NotFoundPage,
});
const indexRoute = createRoute({
  staticData: { settingsBackground: true },
  getParentRoute: () => rootRoute,
  path: "/",
  component: RunComposer,
});
function openStudio(selection: StudioSelection) {
  throw redirect({
    to: settingsReturnPath(),
    search: { studio: selection },
    mask: studioMask(selection),
    replace: true,
  });
}
const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "studio",
  beforeLoad: () => openStudio({ tab: "flows" }),
});
const studioFlowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "studio/flows",
  beforeLoad: () => openStudio({ tab: "flows" }),
});
const studioFlowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "studio/flows/$flowId",
  beforeLoad: ({ params }) => openStudio({ tab: "flows", flowId: params.flowId }),
});
const studioAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "studio/agents",
  beforeLoad: () => openStudio({ tab: "agents" }),
});
const studioAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "studio/agents/$agentId",
  beforeLoad: ({ params }) => openStudio({ tab: "agents", agentId: params.agentId }),
});
const flowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "flows",
  beforeLoad: () => openStudio({ tab: "flows" }),
});
const flowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "flows/$flowId",
  beforeLoad: ({ params }) => openStudio({ tab: "flows", flowId: params.flowId }),
});
const runsRoute = createRoute({
  staticData: { settingsBackground: true },
  getParentRoute: () => rootRoute,
  path: "runs",
  component: RunComposer,
});
const newRunRoute = createRoute({
  staticData: { settingsBackground: true },
  getParentRoute: () => rootRoute,
  path: "runs/new",
  component: RunComposer,
});
const runRoute = createRoute({
  staticData: { settingsBackground: true },
  getParentRoute: () => rootRoute,
  path: "runs/$runId",
  component: RunRoute,
});
function RunRoute() {
  const { runId } = runRoute.useParams();
  return <RunScreen key={runId} id={runId} />;
}
function openSettings(
  selection: SettingsSelection,
  mask: ReturnType<typeof settingsMask> | { to: "/settings" } = settingsMask(selection),
) {
  throw redirect({
    to: settingsReturnPath(),
    search: { settings: selection },
    mask,
    replace: true,
  });
}
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  beforeLoad: () => openSettings({ tab: "connection" }, { to: "/settings" }),
});
const connectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/connection",
  beforeLoad: () => openSettings({ tab: "connection" }),
});
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/agents",
  beforeLoad: () => openStudio({ tab: "agents" }),
});
const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/agents/$agentId",
  beforeLoad: ({ params }) => openStudio({ tab: "agents", agentId: params.agentId }),
});
const runtimeRoute = createRoute({
  staticData: { settingsBackground: true },
  getParentRoute: () => rootRoute,
  path: "settings/runtime",
  beforeLoad: () => openSettings({ tab: "runtime" }),
});
const keyboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/keyboard",
  beforeLoad: () => openSettings({ tab: "keyboard" }),
});
const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/access",
  beforeLoad: () => openSettings({ tab: "access" }),
});
const serverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/server",
  beforeLoad: () => openSettings({ tab: "server" }),
});
const applicationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/application",
  beforeLoad: () => openSettings({ tab: "application" }),
});
const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/skills",
  beforeLoad: () => {
    throw redirect({ to: "/studio/flows", replace: true });
  },
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  studioRoute,
  studioFlowsRoute,
  studioFlowRoute,
  studioAgentsRoute,
  studioAgentRoute,
  flowsRoute,
  flowRoute,
  runsRoute,
  newRunRoute,
  runRoute,
  settingsRoute,
  connectionRoute,
  agentsRoute,
  agentRoute,
  runtimeRoute,
  keyboardRoute,
  accessRoute,
  serverRoute,
  applicationRoute,
  skillsRoute,
]);
export const router = createRouter({ routeTree });

// Remember the last content destination across address-bar/bookmark navigations.
// Route matching, masked locations and all history transitions remain router-owned.
const settingsReturnKey = "factory.settingsReturn";
function isSettingsBackground(path: string) {
  return router
    .matchRoutes(path)
    .some(
      (match) =>
        match.staticData.settingsBackground &&
        trimPathRight(match.pathname) === trimPathRight(path),
    );
}
// The in-memory copy keeps Settings closable when browser storage is unavailable.
let contentPath: string | undefined;
function settingsReturnPath() {
  let path = contentPath;
  try {
    path ??= sessionStorage.getItem(settingsReturnKey) ?? undefined;
  } catch {
    // Storage is unavailable; fall back to the default destination below.
  }
  return path && isSettingsBackground(path) ? path : "/runs/new";
}
router.subscribe("onResolved", ({ toLocation }) => {
  if (
    validateAppSearch(toLocation.search).settings ||
    validateAppSearch(toLocation.search).studio ||
    !isSettingsBackground(toLocation.pathname)
  )
    return;
  contentPath = toLocation.pathname;
  try {
    sessionStorage.setItem(settingsReturnKey, toLocation.pathname);
  } catch {
    // Closing Settings must remain possible without browser storage.
  }
});
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    settingsBackground?: boolean;
  }
  interface Register {
    router: typeof router;
  }
}
