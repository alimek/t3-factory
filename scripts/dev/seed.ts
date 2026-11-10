import { seedScenarioList, type DemoFlows, type SeedScenario } from "./seed-scenarios.ts";
import {
  blockExit,
  controlledAgent,
  archived,
  changesRequested,
  executionFailed,
  missingReport,
  repositoryFactsObserved,
  reportRejected,
  resultReleasedToHumanReview,
  resultReleasedToSecondWorker,
  resultReleasedToTwoWorkers,
  resultReplacedBeforeRelease,
  resultReported,
  resultWaitingAtWait,
  settled,
  snoozed,
  twoWorkersStarted,
  woke,
  workerAtWork,
  workingReportedIdle,
  worktreeBound,
} from "../../apps/backend/test/support/scenarios.ts";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Factory } from "../../apps/backend/src/index.ts";
import type { PersistentT3 } from "./persistent-t3.ts";
import { createDemoFlows } from "./seed-flows.ts";
import { promptAnswered, promptSent } from "../../apps/backend/test/support/continuation.ts";
import {
  delegatedWorkPending,
  requireSuccess,
  demoStart,
  demoNamespace,
  type SeedContext,
  type ScenarioNamespace,
} from "./seed-support.ts";

async function createDemoProject(factory: Factory, t3: PersistentT3, home: string) {
  const root = join(home, "demo-repositories", "atlas");
  await mkdir(root, { recursive: true });
  const initialized = await access(join(root, ".git")).then(
    () => true,
    () => false,
  );
  if (!initialized) await promisify(execFile)("git", ["init", root]);
  await writeFile(
    join(root, "README.md"),
    "# Atlas demo\n\nA disposable local project for exploring T3 Factory.\n" +
      "The development simulator does not call an external model or modify your real repositories.\n",
  );
  const project = requireSuccess(await factory.addRepository({ path: root }));
  t3.projects = t3.projects.map((item) =>
    item.projectId === project.projectId
      ? {
          ...item,
          title: "Atlas demo",
          projectIcon: { kind: "monogram", text: "A", color: "indigo" },
        }
      : item,
  );
  requireSuccess(await factory.recheckProjects());
  requireSuccess(await factory.selectProject({ id: project.id }));
  return project;
}

async function createDemoAgents(factory: Factory, t3: PersistentT3) {
  const agents = { worker: "", reviewer: "", accessibility: "" };
  for (const [key, name, prompt, exits] of [
    [
      "worker",
      "Demo · Product engineer",
      "Implement small, clear improvements to Atlas. Keep changes focused and hand off for review with a concise summary.",
      [blockExit("review", "Ready for review", "Ready for review")],
    ],
    [
      "reviewer",
      "Demo · Code reviewer",
      "Review the implementation for correctness, clarity and focused scope. Explain remaining decisions for the human reviewer.",
      [blockExit("approved", "Approved", "Approved")],
    ],
    [
      "accessibility",
      "Demo · Accessibility reviewer",
      "Review Atlas keyboard navigation, focus behavior and accessible labels. Report concrete findings independently.",
      [blockExit("approved", "Approved", "Approved")],
    ],
  ] as const) {
    const agent = requireSuccess(
      await factory.createAgent(
        controlledAgent(t3.environmentId, {
          name,
          prompt,
          exits,
        }),
      ),
    );
    agents[key] = agent.id;
  }
  return agents;
}

async function createDemoReporting(home: string, environmentId: string) {
  const state = join(home, "reporting-t3-state");
  const codex = join(home, "reporting-codex");
  await mkdir(state, { recursive: true });
  await mkdir(codex, { recursive: true });
  await rm(join(codex, "config.toml"), { force: true });
  await writeFile(join(state, "environment-id"), environmentId);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({
      providerInstances: {
        "codex-main": { driver: "codex", config: { homePath: codex } },
        "demo-claude": {
          driver: "claudeAgent",
          config: { homePath: join(home, "reporting-missing-claude") },
        },
        "demo-cursor": { driver: "cursor" },
      },
    }),
  );
}

/**
 * Devices & access history through the public access operations: one approved and one
 * revoked device. Unanswered requests expire after 15 minutes, so a pending request is
 * shown by requesting access from a browser instead of being seeded.
 */
async function createDemoClients(factory: Factory) {
  const office = requireSuccess(
    await factory.requestClientAccess({ label: "Demo · Office browser", kind: "browser" }),
  );
  requireSuccess(await factory.approveClient(office.client.id));
  const laptop = requireSuccess(
    await factory.requestClientAccess({ label: "Demo · Retired laptop", kind: "desktop" }),
  );
  requireSuccess(await factory.approveClient(laptop.client.id));
  requireSuccess(await factory.revokeClient(laptop.client.id));
}

/** Fresh demo homes only; the owning server records completion and preserves subsequent edits. */
export async function seedDevelopment(
  factory: Factory,
  t3: PersistentT3,
  home: string,
): Promise<void> {
  await createDemoReporting(home, t3.environmentId);
  t3.approve();
  // Runtime readiness requires a loopback hostname. Port zero cannot target a live T3 server.
  requireSuccess(
    await factory.configureConnection({ endpoint: "http://127.0.0.1:0/demo-only/mcp" }),
  );
  const targets = requireSuccess(await factory.getReportingInstallations());
  requireSuccess(
    await factory.installReporting({
      targetId: targets.find((target) => target.instances.includes("codex-main"))!.id,
    }),
  );
  const project = await createDemoProject(factory, t3, home);
  const agents = await createDemoAgents(factory, t3);
  const flows = await createDemoFlows(factory, agents);
  await createDemoClients(factory);
  await seedScenarios({ factory, t3, projectId: project.id }, flows);
}

async function seedScenario(
  context: SeedContext,
  flowId: string,
  scenario: SeedScenario,
  namespace: ScenarioNamespace,
) {
  const start = await demoStart(
    context,
    flowId,
    scenario.key,
    scenario.title,
    scenario.prompt,
    scenario.attachments,
    namespace,
  );
  if (scenario.state === "two workers started from one prompt") {
    const workers = await twoWorkersStarted(context, start);
    for (const [index, repository] of scenario.repositories.entries())
      await repositoryFactsObserved(context, workers[index]!, repository);
    return workers[0].runId;
  }
  if (scenario.state === "Run worktree bound") return (await worktreeBound(context, start)).runId;
  const worker = await workerAtWork(context, start);
  await finishScenario(context, worker, scenario);
  return worker.runId;
}

type Worker = Awaited<ReturnType<typeof workerAtWork>>;
async function finishScenario(
  context: SeedContext,
  worker: Worker,
  scenario: Exclude<
    SeedScenario,
    { state: "two workers started from one prompt" | "Run worktree bound" }
  >,
) {
  switch (scenario.state) {
    case "settled":
      await repositoryFactsObserved(context, worker, scenario.repository);
      await settled(context, await resultReported(context, worker, scenario.result));
      break;
    case "archived":
      await archived(context, worker);
      break;
    case "execution failed":
      await executionFailed(context, worker);
      break;
    case "snoozed":
      await snoozed(context, worker);
      break;
    case "woke":
      await woke(context, worker);
      break;
    case "working reported and idle":
      if (scenario.repository) await repositoryFactsObserved(context, worker, scenario.repository);
      await workingReportedIdle(context, worker, scenario.message);
      break;
    case "missing report":
      await missingReport(context, await reportRejected(context, worker, scenario.rejected));
      break;
    case "result released to a Human review":
    case "changes requested": {
      const reviewer = await resultReleasedToSecondWorker(
        context,
        await resultReported(context, worker, scenario.implementation),
      );
      const review = await resultReleasedToHumanReview(
        context,
        await resultReported(context, reviewer, scenario.review),
      );
      if (scenario.state === "changes requested")
        await changesRequested(context, review, worker, scenario.correction);
      break;
    }
    case "result released to two workers":
      await resultReleasedToTwoWorkers(
        context,
        await resultReplacedBeforeRelease(context, worker, scenario),
      );
      break;
    case "delegated work pending":
      await repositoryFactsObserved(context, worker, scenario.repository);
      await delegatedWorkPending(context, worker, scenario.delegations);
      break;
    case "continuation prompt sent":
    case "continuation response forwarded": {
      const review = await resultReleasedToHumanReview(
        context,
        await resultReported(context, worker, scenario.grill),
      );
      requireSuccess(
        await context.factory.answerHumanOccurrence(review.occurrence.id, {
          exitId: "approve",
          message: scenario.approval,
        }),
      );
      const spec = await promptSent(context, worker);
      if (scenario.state === "continuation response forwarded") {
        await promptAnswered(context, worker, spec, scenario.spec);
        await promptSent(context, worker, "tickets");
      }
      break;
    }
    case "reviews waiting at a Wait": {
      const reviewers = await resultReleasedToTwoWorkers(
        context,
        await resultReported(context, worker, scenario.implementation),
      );
      for (const [index, review] of scenario.reviews.entries())
        await resultWaitingAtWait(
          context,
          await resultReported(context, reviewers[index]!, review),
        );
      break;
    }
  }
}

export async function seedScenarios(
  context: SeedContext,
  flows: DemoFlows,
  namespace: ScenarioNamespace = demoNamespace,
) {
  const runs = new Map<string, string>();
  for (const scenario of seedScenarioList)
    runs.set(scenario.key, await seedScenario(context, flows[scenario.flow], scenario, namespace));
  return runs;
}
