import { demoImages, demoPullRequest, type DemoImage } from "./seed-support.ts";
import type { ThreadFacts } from "../../apps/backend/test/support/controlled-thread.ts";

export type DemoFlows = Record<
  | "simple"
  | "review"
  | "parallel"
  | "parallelStart"
  | "worktree"
  | "continuation"
  | "wait"
  | "parallelWait",
  string
>;
type Repository = NonNullable<ThreadFacts["repository"]>;
type Report = { exit: string; message: string };
export type SeedScenario = {
  key: string;
  title: string;
  flow: keyof DemoFlows;
  prompt: string;
  attachments?: { images: readonly DemoImage[]; referenced: number };
} & (
  | { state: "settled"; repository: Repository; result: Report }
  | { state: "archived" | "execution failed" | "snoozed" | "woke" }
  | { state: "Run worktree bound" }
  | { state: "working reported and idle"; message: string; repository?: Repository }
  | { state: "missing report"; rejected: Report }
  | ({ implementation: Report; review: Report } & (
      | { state: "result released to a Human review" }
      | { state: "changes requested"; correction: string }
    ))
  | { state: "result released to two workers"; first: Report; final: Report }
  | { state: "two workers started from one prompt"; repositories: readonly Repository[] }
  | { state: "result released to a Wait"; result: Report }
  | { state: "results released to a Wait"; results: readonly [Report, Report] }
  | { state: "delegated work pending"; repository: Repository; delegations: number }
  | ({ grill: Report; approval: string } & (
      | { state: "continuation prompt sent" }
      | { state: "continuation response forwarded"; spec: string }
    ))
);

const reviewContent = {
  prompt:
    "Improve Atlas search when there are no results. Keep the search query visible and offer a clear action to reset filters.",
  implementation: {
    exit: "Ready for review",
    message:
      "The empty state now preserves the query and offers Reset filters. Ready for a review.",
  },
  review: {
    exit: "Ready for your decision",
    message:
      "The search behavior looks good. Please review the empty-state wording and decide whether the reset action is clear enough.",
  },
};

const continuationContent = {
  prompt:
    "Plan saved searches for Atlas. Interview me about scope first, then write the spec and the tickets in the same conversation.",
  grill: {
    exit: "Ready for review",
    message: "We agreed on saved searches per project, shareable links and no email alerts yet.",
  },
  approval: "Approved. Leave email alerts out of the first version.",
};

/** Stable keys, titles and creation order are shared with journeys and the scenario catalog.
 * Reading this list needs no Factory; callers supply the saved Flow ids when instantiating it. */
export const seedScenarioList: readonly SeedScenario[] = [
  {
    key: "settled",
    title: "Settled · Clearer onboarding copy",
    flow: "simple",
    state: "settled",
    prompt:
      "Polish the first-run welcome copy for Atlas. Explain where to find recent projects in two short sentences.",
    repository: { branch: "copy/welcome", pullRequests: [demoPullRequest(41, "merged")] },
    result: {
      exit: "Done",
      message: "Updated the welcome text and checked that every action has a descriptive label.",
    },
  },
  {
    key: "archived",
    title: "Archived · Earlier navigation experiment",
    flow: "simple",
    state: "archived",
    prompt:
      "Explore a compact navigation layout for Atlas. This experiment was dropped after a design direction changed.",
    attachments: { images: [demoImages.headerDesktop, demoImages.mockup], referenced: 1 },
  },
  {
    key: "failed",
    title: "Problem · Search checks failed",
    flow: "simple",
    state: "execution failed",
    prompt:
      "Check the search result filters. Investigate why the local checks fail before making further changes.",
  },
  {
    key: "snoozed",
    title: "Snoozed · Navigation research",
    flow: "simple",
    state: "snoozed",
    prompt:
      "Compare the existing navigation labels with the Atlas product glossary. Keep notes for the next design session.",
  },
  {
    key: "woke",
    title: "Woke · A question about keyboard shortcuts",
    flow: "simple",
    state: "woke",
    prompt:
      "Document the search keyboard shortcut. Ask before choosing between slash and command-K.",
  },
  {
    key: "conversation",
    title: "Discussing · Agent asked about empty-state wording",
    flow: "simple",
    state: "working reported and idle",
    prompt:
      "Talk through the empty-state wording for Atlas search with me before changing anything.",
    message: "Discussing the empty-state wording in T3: tone, filters and the button label.",
  },
  {
    key: "rejected-report",
    title: "Problem · Report exit needs correction",
    flow: "simple",
    state: "missing report",
    prompt: "Review the existing navigation wording and report through the Flow's captured exit.",
    rejected: {
      exit: "Unknown exit",
      message: "The review is complete; the exit needs correction.",
    },
  },
  {
    key: "human-review",
    title: "Waiting for your review",
    flow: "review",
    state: "result released to a Human review",
    ...reviewContent,
  },
  {
    key: "correction",
    title: "Applying your requested changes",
    flow: "review",
    state: "changes requested",
    ...reviewContent,
    correction:
      "Rename Reset filters to Clear filters and keep keyboard focus in the search field.",
  },
  {
    key: "parallel",
    title: "Two reviewers working in parallel",
    flow: "parallel",
    state: "result released to two workers",
    prompt:
      "Review the new project picker for code quality and keyboard accessibility. Each reviewer should report independently.",
    first: { exit: "Ready for review", message: "The picker is ready for a code review." },
    final: {
      exit: "Ready for review",
      message:
        "The picker is ready. Please review both implementation quality and keyboard navigation.",
    },
  },
  {
    key: "parallel-start",
    title: "Parallel review from one prompt",
    flow: "parallelStart",
    state: "two workers started from one prompt",
    prompt:
      "Review the Atlas settings page for code quality and for keyboard accessibility. Each reviewer starts from this prompt and reports independently.",
    attachments: {
      images: [
        demoImages.headerDesktop,
        demoImages.headerMobile,
        demoImages.focusRing,
        demoImages.mockup,
      ],
      referenced: 3,
    },
    repositories: [
      { branch: "review/project-picker", pullRequests: [demoPullRequest(42)] },
      {
        branch: "review/keyboard-accessibility",
        pullRequests: [demoPullRequest(42), demoPullRequest(43)],
      },
    ],
  },
  {
    key: "wait-pending",
    title: "Waiting · Release notes settle before review",
    flow: "wait",
    state: "result released to a Wait",
    prompt:
      "Draft the release notes for the Atlas search update, then let CI settle before a review.",
    result: {
      exit: "Ready for review",
      message:
        "Release notes drafted from the merged search changes. Ready for review once CI settles.",
    },
  },
  {
    key: "wait-arrivals",
    title: "Waiting · Two reviews held for the morning sync",
    flow: "parallelWait",
    state: "results released to a Wait",
    prompt:
      "Review the Atlas filters panel for code quality and keyboard accessibility; we decide together at the morning sync.",
    results: [
      { exit: "Approved", message: "The filters code is ready; one naming nit is noted inline." },
      {
        exit: "Approved",
        message: "Keyboard navigation works; focus returns to the filter button after closing.",
      },
    ],
  },
  {
    key: "worktree",
    title: "Worktree · Search fix on its own branch",
    flow: "worktree",
    state: "Run worktree bound",
    prompt:
      "Fix the search highlighting in a separate worktree so the project checkout stays untouched, then hand off for review.",
  },
  {
    key: "working-report",
    title: "Monitoring · Agent is watching CI for the search fix",
    flow: "simple",
    state: "working reported and idle",
    prompt:
      "Fix the search ranking regression, open a pull request and wait for its CI checks before reporting.",
    message:
      "Opened pull request #42 with the ranking fix. CI checks are still running; I will report when they finish.",
    repository: { branch: null, pullRequests: [demoPullRequest(42)] },
  },
  {
    key: "continuation-sent",
    title: "Continuation · Spec prompt sent to the planning thread",
    flow: "continuation",
    state: "continuation prompt sent",
    ...continuationContent,
  },
  {
    key: "continuation-forwarded",
    title: "Continuation · Spec passed on to Tickets",
    flow: "continuation",
    state: "continuation response forwarded",
    ...continuationContent,
    spec: "Spec written to docs/saved-searches.md with four open questions.",
  },
  {
    key: "working",
    title: "Working · Improve the project picker",
    flow: "simple",
    state: "delegated work pending",
    prompt:
      "Add a concise empty state to the Atlas project picker, including a hint to open an existing repository.",
    repository: {
      branch: "feature/project-picker-empty-state-and-keyboard-navigation",
      pullRequests: [],
    },
    delegations: 2,
  },
];
