import type { LaunchChoices, LaunchChoicesLiveMessage } from "@t3-factory/contracts";
import { useLiveScope } from "./live-connection.ts";
import type { LiveScope } from "./owner.ts";
import { applyChanges, flowOrder } from "./scopes.ts";

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
    const flows = applyChanges(choices.flows, message.flows, flowOrder);
    return { catalog: message.catalog ?? choices.catalog, flows };
  },
};

/** The composer's Project catalog and Flows, live while the composer is shown. */
export const useLiveLaunchChoices = () => useLiveScope(launchChoicesScope);
