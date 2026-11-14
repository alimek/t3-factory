import { agentOperations } from "./agent.ts";
import { flowOperations } from "./flow.ts";
import { projectOperations, projectServerOperations } from "./project.ts";
import { connectionOperations } from "./connection.ts";
import { appearanceOperations, type AppearanceSource } from "./appearance.ts";
import { runOperations } from "./run.ts";
import { chatControlOperations } from "./chat-control.ts";
import {
  type ClientAccessState,
  type FactoryClient,
  clientAccessOperations,
  clientAccessServerOperations,
} from "./client-access.ts";
import type { FacadeOperations } from "./operation.ts";
import type { Result } from "./result.ts";
import { serverUpdateOperations } from "./update.ts";

/** Every HTTP operation, including those answered by the server around the facade. */
export const httpOperations = {
  ...agentOperations,
  ...flowOperations,
  ...projectOperations,
  ...projectServerOperations,
  ...connectionOperations,
  ...appearanceOperations,
  ...runOperations,
  ...chatControlOperations,
  ...clientAccessOperations,
  ...clientAccessServerOperations,
  ...serverUpdateOperations,
};

/** The Factory facade: derived from the operation definitions, plus operations HTTP does not reach. */
export interface FactoryOperations extends FacadeOperations<
  typeof agentOperations &
    typeof flowOperations &
    typeof projectOperations &
    typeof connectionOperations &
    typeof appearanceOperations &
    typeof runOperations &
    typeof chatControlOperations &
    typeof clientAccessOperations
> {
  reconcileRuns(): Promise<Result<void>>;
  getClientAccess(credential: string): Promise<Result<ClientAccessState>>;
  /** The identity this Factory's data home was created with; it never changes. */
  getServerId(): Promise<Result<string>>;
  /** The source theme colors currently come from; null without an active grant to follow. */
  getAppearanceSource(): Promise<Result<AppearanceSource | null>>;
  authenticateClient(credential: string): Promise<Result<FactoryClient>>;
}
