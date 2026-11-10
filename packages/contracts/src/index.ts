/** Transport-neutral values shared by the backend and its clients. No Node imports. */
import type { agentOperations } from "./agent.ts";
import type { flowOperations } from "./flow.ts";
import type { projectOperations } from "./project.ts";
import type { connectionOperations } from "./connection.ts";
import type { runOperations } from "./run.ts";
import type { ClientAccessState, FactoryClient, clientAccessOperations } from "./client-access.ts";
import type { FacadeOperations } from "./operation.ts";
import type { Result } from "./result.ts";

export * from "./result.ts";
export * from "./flow.ts";
export * from "./agent.ts";
export * from "./operation.ts";
export * from "./project.ts";
export * from "./connection.ts";
export * from "./run.ts";
export * from "./client-access.ts";
export * from "./update.ts";

/** The Factory facade: derived from the operation definitions, plus operations HTTP does not reach. */
export interface FactoryOperations extends FacadeOperations<
  typeof agentOperations &
    typeof flowOperations &
    typeof projectOperations &
    typeof connectionOperations &
    typeof runOperations &
    typeof clientAccessOperations
> {
  reconcileRuns(): Promise<Result<void>>;
  getClientAccess(credential: string): Promise<Result<ClientAccessState>>;
  authenticateClient(credential: string): Promise<Result<FactoryClient>>;
}

export * from "./live.ts";
