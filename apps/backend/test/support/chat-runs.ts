import { assert, expect, type TestContext } from "@effect/vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryProject } from "@t3-factory/contracts";
import type { Factory } from "../../src/index.ts";
import {
  ALLOWED_CHANNEL,
  discordBot,
  discordGuild,
  savedChatModel,
  savedDiscordConnection,
  turnedOn,
} from "./chat-control.ts";
import { addThreads, COLLABORATOR_ID } from "./chat-conversation.ts";
import { controlledDiscord, PARTICIPANT_ID, type ControlledDiscord } from "./controlled-discord.ts";
import { controlledModelProvider, type ControlledModel } from "./controlled-model.ts";
import { prepared } from "./prepared-runner.ts";
import { remoteServer } from "./remote-clients.ts";
import { installFirstReportingTarget } from "./reporting.ts";
import type { ReadyFlowShape } from "./scenarios.ts";

/** Chat control's external worlds: the controlled model and Discord with the allowed threads. */
async function chatWorlds(c: TestContext) {
  const model = await controlledModelProvider(c);
  const discord = await controlledDiscord(c);
  discord.addBot(discordBot);
  discord.addGuild(discordGuild);
  addThreads(discord);
  return { model, discord };
}

/** Saves the Language model and connection, allows the participant and collaborator for
 * `projectIds` in the allowed channel and turns Chat control On. */
async function operating(
  factory: Factory,
  { model, discord }: { model: ControlledModel; discord: ControlledDiscord },
  projectIds: readonly string[],
) {
  await savedChatModel(factory, { baseUrl: model.baseUrl() });
  await savedDiscordConnection(factory);
  const access = await factory.updateDiscordAccess({
    revision: 0,
    users: [PARTICIPANT_ID, COLLABORATOR_ID],
    channels: [{ channelId: ALLOWED_CHANNEL, projectIds }],
  });
  assert(access.ok, JSON.stringify(access));
  await turnedOn(factory, discord);
}

/**
 * An operating Chat control over the prepared ready Flow (or `shape`): the participant and a
 * collaborator are allowed in the allowed channel for the prepared Project, with the threads of
 * `conversing`. The model answers "OK" unless scripted.
 */
export async function runConversation(c: TestContext, shape?: ReadyFlowShape) {
  const worlds = await chatWorlds(c);
  const fixture = await prepared(c, shape, { discordApiUrl: worlds.discord.apiUrl });
  await operating(fixture.f, worlds, [fixture.project.id]);
  return { ...fixture, ...worlds };
}

/** As `runConversation` on a listening server whose approved desktop client reads Runs remotely. */
export async function remoteRunConversation(c: TestContext) {
  const worlds = await chatWorlds(c);
  const fixture = await prepared(c, undefined, { discordApiUrl: worlds.discord.apiUrl });
  await fixture.f.close();
  const server = await remoteServer(c, {
    home: fixture.h.processHome,
    t3: fixture.t3,
    reportingStateDirectory: join(fixture.h.processHome, "reporting-state"),
    discordApiUrl: worlds.discord.apiUrl,
    connectionRetryMs: 60_000,
  });
  // The reporting entry must name this server's actual Factory MCP URL.
  await installFirstReportingTarget(server.factory);
  await operating(server.factory, worlds, [fixture.project.id]);
  const laptop = await server.approved("Laptop");
  return {
    ...worlds,
    f: server.factory,
    input: fixture.input,
    /** What the approved client reads at `path`, as sent over the wire. */
    approvedRead: async (path: string) => JSON.stringify(await laptop.send("GET", path)),
  };
}

type Prepared = Awaited<ReturnType<typeof prepared>>;

/** A Run of the prepared Flow started in Factory, titled by its prompt's first line. */
export async function startedRun(
  { f, input }: Pick<Prepared, "f" | "input">,
  run: {
    readonly requestId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly projectId?: string;
  },
) {
  const started = await f.startRun({
    ...input,
    requestId: run.requestId,
    input: `${run.title}\nKeep it accessible.`,
    title: run.title,
    createdAt: run.createdAt,
    projectId: run.projectId ?? input.projectId,
  });
  assert(started.ok, JSON.stringify(started));
  return started.value;
}

/** Another repository Factory knows, at `path` under the harness home. */
export async function addedProject(
  { f, h }: Pick<Prepared, "f" | "h">,
  path: string,
): Promise<FactoryProject> {
  const root = join(h.processHome, path);
  await mkdir(root, { recursive: true });
  const project = await f.addRepository({ path: root });
  assert(project.ok, JSON.stringify(project));
  return project.value;
}

/** The model asks for these tool calls in one answer. */
export const calls = (...toolCalls: { name: string; input: unknown }[]) => ({ toolCalls });
export const findRuns = (input: Record<string, unknown> = {}) => ({ name: "find_runs", input });
export const readRun = (input: Record<string, unknown>) => ({ name: "read_run", input });

/** A Run as Find Runs and Read Run identify it. */
export const runIdentity = (
  run: { id: string; number: number | null; title: string },
  project: FactoryProject,
  state = "active",
) => ({
  id: run.id,
  number: run.number,
  title: run.title,
  project: { id: project.id, name: project.title, repositoryPath: project.workspaceRoot },
  flow: "Single worker",
  state,
  startedAt: expect.any(String),
});

/** `count` Runs created one minute apart from 08:`firstMinute`, oldest first, titled "<title> <n>". */
export async function startedRuns(
  fixture: Pick<Prepared, "f" | "input">,
  count: number,
  title: string,
  firstMinute = 0,
) {
  const runs = [];
  for (let index = 0; index < count; index++)
    runs.push(
      await startedRun(fixture, {
        requestId: `${title}-${index + 1}`,
        title: `${title} ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 10, 7, 8, firstMinute + index)).toISOString(),
      }),
    );
  return runs;
}
