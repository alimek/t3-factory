import type { LaunchChoices, LaunchChoicesLiveMessage } from "@t3-factory/contracts";
import { useLiveScope } from "./live-connection.ts";
import type { LiveScope } from "./owner.ts";

export const launchChoicesScope: LiveScope<LaunchChoicesLiveMessage, LaunchChoices> = {
  key: "launchChoices",
  part: { kind: "launchChoices" },
  snapshot: (message) => message.choices,
  apply: (choices, message) => {
    if (message._tag === "observed") {
      const observedAt = new Map(
        message.projects.map((project) => [project.id, project.observedAt]),
      );
      const projects = choices.catalog.projects.map((project) => ({
        ...project,
        observedAt: observedAt.get(project.id) ?? project.observedAt,
      }));
      return { ...choices, catalog: { ...choices.catalog, projects } };
    }
    if (!message.flows) return { ...choices, catalog: message.catalog ?? choices.catalog };
    const byId = new Map(choices.flows.map((flow) => [flow.id, flow]));
    for (const flow of message.flows.upserts) byId.set(flow.id, flow);
    for (const id of message.flows.removals) byId.delete(id);
    // Match SQLite's ORDER BY created_at DESC, id (binary collation).
    const flows = [...byId.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return { catalog: message.catalog ?? choices.catalog, flows };
  },
};

/** The composer's Project catalog and Flows, live while the composer is shown. */
export const useLiveLaunchChoices = () => useLiveScope(launchChoicesScope);
