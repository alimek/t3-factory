import type { E2EConfig } from "e2e";
import { chatgpt } from "e2e/oauth/chatgpt";
import base from "./e2e.config.ts";

// Keep model authentication out of the deterministic regression suite and MCP.
const config: E2EConfig = {
  ...base,
  output: ".e2e/explore",
  agents: {
    default: {
      model: chatgpt(process.env.E2E_MODEL ?? "gpt-6-luna"),
      maxSteps: 25,
      maxModelCalls: 30,
      system:
        "Explore T3 Factory as a careful user. Verify outcomes on screen and report reproducible defects with expected and actual behavior. Use only the disposable seeded projects. Keep the controlled T3 connection unchanged; do not add real repository paths or external endpoints.",
      context:
        "This is the real built Factory UI and SQLite backend with a ControlledT3 adapter, not a live T3 integration. Seeded Agents include Sample worker and Launch worker. Launch ready Flow can run against neutral-launch. Runtime worker and neutral-repository intentionally start without validated runtime setup. Seeded development Runs include worker questions, Human review and closure states. Native t3:// links, real OAuth, harness trust, and real model execution cannot be validated here. Disabled launch controls for incomplete drafts are expected. Distinguish these fixture limits from defects.",
    },
  },
} satisfies E2EConfig;

export default config;
