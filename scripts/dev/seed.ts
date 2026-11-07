import { execFile } from "node:child_process";
import { access, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Factory } from "../../apps/backend/src/index.ts";
import type { PersistentT3 } from "./persistent-t3.ts";
import { createDemoFlows } from "./seed-flows.ts";
import { seedScenarios } from "./seed-scenarios.ts";
import { requireSuccess } from "./seed-support.ts";

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
    item.projectId === project.projectId ? { ...item, title: "Atlas demo" } : item,
  );
  requireSuccess(await factory.recheckProjects());
  requireSuccess(await factory.selectProject({ id: project.id }));
  return project;
}

async function createDemoAgents(factory: Factory, t3: PersistentT3) {
  const agents = { worker: "", reviewer: "", accessibility: "" };
  for (const [key, name, prompt] of [
    [
      "worker",
      "Demo · Product engineer",
      "Implement small, clear improvements to Atlas. Keep changes focused and hand off for review with a concise summary.",
    ],
    [
      "reviewer",
      "Demo · Code reviewer",
      "Review the implementation for correctness, clarity and focused scope. Explain remaining decisions for the human reviewer.",
    ],
    [
      "accessibility",
      "Demo · Accessibility reviewer",
      "Review Atlas keyboard navigation, focus behavior and accessible labels. Report concrete findings independently.",
    ],
  ] as const) {
    const agent = requireSuccess(
      await factory.createAgent({
        name,
        prompt,
        execution: {
          environmentId: t3.environmentId,
          providerInstanceId: "codex-main",
          modelId: "gpt-6.1-sol",
          modelOptions: [{ id: "reasoning", value: "high" }],
        },
      }),
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
  await seedScenarios(
    { factory, t3, projectId: project.id, t3ProjectId: project.projectId },
    flows,
  );
}
