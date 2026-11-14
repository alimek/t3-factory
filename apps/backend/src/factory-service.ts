import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { FactoryOperations, OperationError, Result, RunDetail } from "@t3-factory/contracts";
import type { EffectOperations } from "./effect-operations.ts";
import type { FactoryOptions } from "./factory-options.ts";
import { makeConnection } from "./connection.ts";
import { makeAppearance } from "./appearance/appearance.ts";
import { makeProjects } from "./projects.ts";
import { makeDefinitions } from "./definitions.ts";
import * as RuntimeSetup from "./runtime-setup.ts";
import * as ReportingInstaller from "./reporting-installation.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import { createRuntime, type RuntimeReports } from "./runtime.ts";
import type { acquireRunnerOwner } from "./runner-owner.ts";
import { makeRunner } from "./runner/runner.ts";
import { makeClientAccess } from "./client-access.ts";
import { makeRunImages } from "./run-images.ts";
import { makeRunTitles } from "./run-titles.ts";
import { makeChatCredentials } from "./chat-control/credentials.ts";
import { conversationalModel, makeChatModel } from "./chat-control/model.ts";
import { makeChatActions } from "./chat-control/actions.ts";
import { discoveryTools } from "./chat-control/chat-tools.ts";
import { makeChatDeliveries } from "./chat-control/deliveries.ts";
import { startAction } from "./chat-control/start-action.ts";
import { makeChatDiscord } from "./chat-control/discord.ts";
import { DISCORD_API_URL, makeDiscordGateway } from "./chat-control/discord-gateway.ts";
import { makeDiscordOperation } from "./chat-control/discord-operation.ts";
import { failure } from "./result.ts";
import { makeLiveChanges } from "./live-changes.ts";
import { makeLiveStreams, type LiveStreams } from "./live-streams.ts";

/** Public Effect service shared by HTTP, background workers and controlled-clock tests. */
export class FactoryService extends Context.Service<
  FactoryService,
  EffectOperations<FactoryOperations> & {
    readonly runtime: RuntimeReports;
    /** Factory MCP's text-only Start; the Start form uses `startRun`. */
    readonly startTextRun: (input: unknown) => Effect.Effect<Result<RunDetail>>;
    readonly setRuntimeBackendUrl: (url: string) => void;
    readonly live: LiveStreams;
  }
>()("factory/FactoryService") {}

type FactoryEffectOperations = EffectOperations<FactoryOperations>;

const guard = <A>(operation: Effect.Effect<Result<A>, unknown>): Effect.Effect<Result<A>> =>
  operation.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed(failure("internal", "Factory could not complete the operation.")),
    ),
  );

/** Sanitizes every public operation's defects into an `internal` Result; interruption still propagates. */
function guardOperations(operations: FactoryEffectOperations): FactoryEffectOperations {
  const guarded: Record<string, unknown> = {};
  for (const [name, operation] of Object.entries(operations) as [
    string,
    (...args: unknown[]) => Effect.Effect<Result<unknown>, unknown>,
  ][])
    guarded[name] = (...args: unknown[]) => guard(operation(...args));
  return guarded as FactoryEffectOperations;
}

/** Composition root: wires domain modules to one T3 adapter and delegates each public operation. */
/** The typed error a live read reports when its read transaction cannot run. */
const liveReadError: OperationError = {
  code: "internal",
  message: "Live data could not be read.",
  issues: [],
};

export const makeFactoryService = (
  options: FactoryOptions,
  owner: Awaited<ReturnType<typeof acquireRunnerOwner>>,
  t3: T3Adapter,
  credentialsDirectory: string,
) =>
  Effect.gen(function* () {
    const intervalMs = options.connectionRetryMs ?? 5_000;
    const changes = makeLiveChanges();
    const sql = yield* SqlClient.SqlClient;
    const connection = yield* makeConnection(t3, intervalMs, changes);
    const appearance = yield* makeAppearance(t3, connection.getConnection, intervalMs, changes);
    const projects = yield* makeProjects(t3, connection, intervalMs, changes);
    yield* projects.recheckProjects();
    const definitions = yield* makeDefinitions(t3, connection, changes);
    const clients = yield* makeClientAccess;
    const images = yield* makeRunImages(join(dirname(options.databasePath), "images"));
    let runtimeBackendUrl = options.runtimeBackendUrl ?? "http://127.0.0.1:4310";
    const reportingContext = yield* Layer.build(
      ReportingInstaller.ReportingInstallerLayer(
        dirname(options.databasePath),
        options.reportingStateDirectory ??
          process.env.FACTORY_T3_STATE_DIRECTORY ??
          join(homedir(), ".t3", "userdata"),
        connection.getConnection,
        () => `${runtimeBackendUrl}/mcp`,
      ),
    );
    const reporting = Context.get(reportingContext, ReportingInstaller.ReportingInstaller);
    const setupContext = yield* Layer.build(
      RuntimeSetup.RuntimeSetupLayer(
        {
          getReportingInstallations: reporting.getReportingInstallations,
          getConnection: connection.getConnection,
          recheckConnection: connection.recheckConnection,
          listProjects: projects.listProjects,
          recheckProjects: projects.recheckProjects,
          getAgent: definitions.getAgent,
          getAgentCapabilities: definitions.getAgentCapabilities,
        },
        t3,
      ),
    );
    const setup = Context.get(setupContext, RuntimeSetup.RuntimeSetup);
    const runTitles = yield* makeRunTitles(
      t3,
      {
        getConnection: connection.getConnection,
        getAgentCapabilities: definitions.getAgentCapabilities,
        getReportingInstallations: reporting.getReportingInstallations,
      },
      changes,
    );
    const chatCredentials = yield* makeChatCredentials(credentialsDirectory);
    const discordGateway = yield* makeDiscordGateway(options.discordApiUrl ?? DISCORD_API_URL);
    let runner: Effect.Success<ReturnType<typeof makeRunner>>;
    const chatStart = startAction({
      listProjects: projects.listProjects,
      getFlow: definitions.getFlow,
      getRunTitleSetting: runTitles.getRunTitleSetting,
      startTextRun: (input) => guard(runner.startTextRun(input)),
      acceptedStart: (requestId) => runner.acceptedStart(requestId),
    });
    const chatDeliveries = yield* makeChatDeliveries(sql);
    const chatActions = yield* makeChatActions(sql, [chatStart.operation], chatDeliveries);
    const discordOperation = yield* makeDiscordOperation(discordGateway, chatCredentials, {
      model: conversationalModel(sql, chatCredentials),
      tools: [
        ...discoveryTools({
          listProjects: projects.listProjects,
          listFlows: definitions.listFlows,
        }),
        chatStart.tool,
      ],
      actions: chatActions,
      deliveries: chatDeliveries,
    });
    const chatModel = yield* makeChatModel(chatCredentials, discordOperation.modelSaved);
    const chatDiscord = yield* makeChatDiscord(chatCredentials, discordGateway, discordOperation, {
      actions: chatActions,
      deliveries: chatDeliveries,
    });
    const runtimeReports = createRuntime(
      (publicId, report) => runner.consumeBlockUpdate(publicId, report),
      (kind, input) => runner.readFactoryTool(kind, input),
      runTitles.setRunTitle,
    );
    // A literal without spreads: guardOperations and the Promise facade expose exactly these keys.
    const operations: FactoryEffectOperations = {
      createFlow: definitions.createFlow,
      validateFlow: definitions.validateFlow,
      updateFlow: definitions.updateFlow,
      removeFlow: definitions.removeFlow,
      listFlows: definitions.listFlows,
      getFlow: definitions.getFlow,
      getAgentCapabilities: definitions.getAgentCapabilities,
      listAgents: definitions.listAgents,
      getAgent: definitions.getAgent,
      createAgent: definitions.createAgent,
      updateAgent: definitions.updateAgent,
      duplicateAgent: definitions.duplicateAgent,
      removeAgent: definitions.removeAgent,
      getReportingInstallations: () => reporting.getReportingInstallations(),
      installReporting: (input) => reporting.installReporting(input),
      answerHumanOccurrence: (id, input) => runner.answerHumanOccurrence(id, input),
      continueWaitArrival: (id) => runner.continueWaitArrival(id),
      listAttention: () => runner.listAttention(),
      requestReport: (id, input) => runner.requestReport(id, input),
      archiveRun: (id) => runner.archiveRun(id),
      settleRun: (id, input) => runner.settleRun(id, input),
      getRunCreationPolicy: () => runner.getRunCreationPolicy(),
      getRunTitleSetting: () => runTitles.getRunTitleSetting(),
      updateRunTitleSetting: (input) => runTitles.updateRunTitleSetting(input),
      getChatModelSettings: () => chatModel.getChatModelSettings(),
      updateChatModelSettings: (input) => chatModel.updateChatModelSettings(input),
      testChatModel: (input) => chatModel.testChatModel(input),
      getDiscordSettings: () => chatDiscord.getDiscordSettings(),
      updateDiscordConnection: (input) => chatDiscord.updateDiscordConnection(input),
      checkDiscordConnection: (input) => chatDiscord.checkDiscordConnection(input),
      updateDiscordAccess: (input) => chatDiscord.updateDiscordAccess(input),
      setChatControlEnabled: (input) => chatDiscord.setChatControlEnabled(input),
      retryChatDelivery: (input) => chatDiscord.retryChatDelivery(input),
      startRun: (i) => runner.startRun(i),
      getRunImageInfo: (sha256) => images.getRunImageInfo(sha256),
      stageRunImage: (sha256, input) => images.stageRunImage(sha256, input),
      getRunImage: (sha256) => images.getRunImage(sha256),
      listEligibleRunImages: (projectId) => images.listEligibleRunImages(projectId),
      deleteRunImages: (input) => images.deleteRunImages(input),
      listRunNavigation: () => runner.listRunNavigation(),
      renameRun: (id, input) => runner.renameRun(id, input),
      snoozeRun: (id) => runner.snoozeRun(id),
      restoreRun: (id) => runner.restoreRun(id),
      markRunWokeSeen: (id) => runner.markRunWokeSeen(id),
      getRun: (id) => runner.getRun(id),
      listRuns: (id) => runner.listRuns(id),
      listTasks: (id) => runner.listTasks(id),
      updateTask: (id, input) => runner.updateTask(id, input),
      reconcileRuns: () => runner.reconcileRuns(),
      recheckRuntime: (i) => setup.recheckRuntime(i),
      listProjects: () => projects.listProjects(),
      recheckProjects: () => projects.recheckProjects(),
      addRepository: (input) => projects.addRepository(input),
      selectProject: (input) => projects.selectProject(input),
      getProjectReadiness: (id) => projects.getProjectReadiness(id),
      getProjectFavicon: (id) => projects.getProjectFavicon(id),
      getConnection: () => connection.getConnection(),
      configureConnection: (input) => connection.configureConnection(input),
      recheckConnection: () => connection.recheckConnection(),
      authorizeConnection: () => connection.authorizeConnection(),
      openConnectionAuthorization: () => connection.openConnectionAuthorization(),
      pairAppearance: (input) => appearance.pairAppearance(input),
      disconnectAppearance: () => appearance.disconnectAppearance(),
      requestClientAccess: (input) => clients.requestClientAccess(input),
      getClientAccess: (credential) => clients.getClientAccess(credential),
      getServerId: () => clients.getServerId(),
      getAppearanceSource: () => appearance.getAppearanceSource(),
      authenticateClient: (credential) => clients.authenticateClient(credential),
      listClients: () => clients.listClients(),
      approveClient: (id) => clients.approveClient(id),
      denyClient: (id) => clients.denyClient(id),
      revokeClient: (id) => clients.revokeClient(id),
      getHostLifecycle: () => clients.getHostLifecycle(),
    };
    const guarded = guardOperations(operations);
    const factory: FactoryService["Service"] = {
      ...guarded,
      runtime: runtimeReports,
      startTextRun: (input) => guard(runner.startTextRun(input)),
      setRuntimeBackendUrl: (url) => {
        runtimeBackendUrl = url;
      },
      live: makeLiveStreams(
        changes,
        {
          ...guarded,
          readProjectCatalog: () => guard(projects.readCatalog()),
          getAppearance: appearance.getAppearance,
        },
        (read) =>
          sql
            .withTransaction(read)
            .pipe(Effect.catchTag("SqlError", () => Effect.fail(liveReadError))),
      ),
    };
    runner = yield* makeRunner(
      factory,
      t3,
      owner,
      intervalMs,
      (projectId, agent) => setup.recheckAgent(projectId, agent),
      changes,
      images,
      runTitles,
    );
    yield* runner.initialize();
    // Chat actions interrupted by a stop reconcile their Start identity once the Runner owns Runs.
    yield* chatActions.recover;
    return factory;
  });
