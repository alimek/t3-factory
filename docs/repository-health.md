# Repository health

Periodic gardening assesses the repository against seven KPIs, records the
evidence and identifies worthwhile improvements. An assessment authorizes review
only; implementing its findings is a separate task. These are engineering
judgments, not automated measurements or a release qualification.

## KPIs

The rubric is **version 1**. Each KPI has a stable ID and an integer score from
**0 to 10**, with higher always better. Assess the current requirements and
documented support limits. Necessary domain complexity, unsupported platforms and
hypothetical future features are not defects.

| ID | KPI | What to assess | What 10 means |
| --- | --- | --- | --- |
| K1 | Architecture and ease of change | Ownership of behavior, dependency direction, interface depth and how far a change spreads across callers. | Behavior has a clear owner whose interface enforces its invariants; changes remain local without duplicated coordination. |
| K2 | Simplicity and readability | Names, control flow, duplication, dead code, abstractions and the effort required to understand behavior. | Code expresses the required behavior clearly; no identified simplification would improve it while preserving the contract. |
| K3 | Test quality | Protection of important business expectations, meaningful assertions, determinism and maintenance cost. | Important normal, failure, race and recovery behavior has reliable protection, with no identified material gaps or redundant tests. |
| K4 | Reliability and data preservation | Restarts, interrupted operations, retries, connection loss, concurrency, migrations and actionable errors. | Supported operations preserve correct state and data, recover as promised and expose failures clearly. |
| K5 | Security | Validation at trust boundaries, authorization, secret handling and dependency risks in reachable supported behavior. | Reviewed boundaries enforce their intended access rules, with no known unresolved vulnerability in the declared assessment scope. |
| K6 | Developer workflow | Reproducible setup, checks, feedback time, diagnostics and the ability to verify changes safely. | A contributor can start and verify work predictably; tooling provides timely, actionable feedback without avoidable friction. |
| K7 | Documentation and terminology | Agreement with implementation, discoverability, contracts, support limits and consistent domain terms. | Needed information is current, discoverable and unambiguous, with no identified material omissions or contradictions. |

K1 concerns where behavior lives; K2 concerns understanding its implementation.
K3 concerns regression protection; K4 concerns runtime behavior. A finding may
affect more than one KPI, but explain its distinct consequence in each.

## Scale and evidence

| Score | Anchor |
| --- | --- |
| 0 | Worst meaningful state: the area provides effectively none of its intended value. |
| 1–3 | Serious, pervasive or critical problems; fundamental improvement is needed. |
| 4–6 | Useful behavior exists, but material weaknesses or costly limitations remain. |
| 7–8 | Good overall; concrete, bounded problems remain. |
| 9 | Very good; only minor, justified improvements remain. |
| 10 | Current needs are met and the review identifies no justified improvement within its declared scope. |

A 10 is attainable. It means no identified work is needed in the assessed scope,
not a guarantee against unknown defects. Do not reserve points for taste,
speculative extensibility or the claim that everything can always improve.
Within a band, choose the integer that reflects the impact and breadth of the
remaining problems and explain that choice. A confirmed serious security or
data-loss defect belongs in the 1–3 band for its affected KPI even if unrelated
parts are strong.

Every score needs strengths, source or execution evidence, and the concrete
issues preventing 10; for 10, explicitly state that none were found. File size,
test count, line coverage and a green quality gate do not determine a score on
their own. Use the [testing policy](testing.md) to judge test value and
[change review criteria](quality-gates.md#change-review) to judge design.

Record confidence separately from the score: **high** for broad direct evidence
across the assessed area, **medium** for representative source inspection with
explicit gaps, and **low** for narrow or indirect evidence. Use **N/A** when
evidence is insufficient to assign a defensible score; missing evidence is not a
zero or a demonstrated defect. Distinguish source inspection, executed controlled
tests and live qualification. Controlled tests do not establish live T3, native
desktop or cross-device compatibility; see [support limits](installation.md).

## Independent assessment

1. Fix the source commit, rubric version and scope before dispatch. Record
   relevant uncommitted changes separately. Give each evaluator the same rubric
   and repository access, without earlier scores, peer findings or a preferred
   outcome. Each evaluator assesses all seven KPIs rather than a different slice.
2. Choose the model and harness explicitly. Record the actual model identifier,
   harness, reasoning/effort settings and any provider-reported identity limit.
   A model or harness change starts a new comparison series; do not treat its
   score difference alone as an improvement or regression. An unavailable entry
   is recorded as unavailable, not silently replaced.
3. Read the repository instructions and relevant contracts, then inspect
   implementation and representative tests. Stay read-only apart from assigned
   ignored evidence storage. Coordinate check execution so several sessions do
   not contend for build output or duplicate costly work. Shared check results
   must name the source revision and be identified as shared evidence.
4. Return all seven scores with confidence, evidence, strengths, blockers to 10
   and evidence limits. Label suspected defects as hypotheses until verified.
   Security claims need a concrete trust-boundary violation; private credentials,
   local addresses and exploit details stay out of the public summary.
5. Verify the factual claims behind material deductions against source or a
   suitable existing controlled check. Preserve each evaluator's original score
   and mark rejected or unresolved claims. Compare assessments only after all
   independent results are in. Differences are review input, not votes proving
   that a finding is real.
6. Update the compact assessment below with the date, source commit, evaluator
   configuration, seven original scores, confidence and reviewed conclusions.
   Keep raw reports and execution evidence in ignored `.e2e/` storage and
   summarize checks and limits in the PR. Git history and assessment PRs retain
   earlier results; replace the current summary rather than accumulating raw
   reports here. Improvements require a separate agreed task, followed by a new
   assessment on its resulting commit.

Keep the seven results separate; there is no overall average or weighting.
Compare like-for-like assessments using the same rubric, scope and evaluator
configuration, and explain score changes with verified changes in the repository.
Finding more issues on a later pass does not itself prove the code regressed.

### Evaluator brief

Supply this brief with the KPIs, scale and evidence rules above, the fixed source
commit and the selected evaluator configuration. Keep prior assessment results
out of the evaluator's starting context.

> Assess the specified T3 Factory commit using repository-health rubric v1.
> Follow the repository instructions and evaluate K1–K7 independently of other
> evaluators. Review only; leave product code, tests and documentation unchanged.
> For each KPI return an integer 0–10 or N/A, confidence, strengths, evidence
> references and concrete blockers to 10. Distinguish observed defects from
> hypotheses and source evidence from executed checks. State inspected scope,
> unverified areas, commands actually run and actual model/harness/settings.
> Judge current supported requirements; 10 is attainable and needs no invented
> improvement. Do not use test counts or coverage as quality targets. Suggest
> follow-up work, but do not implement it.

## Current assessment

The initial assessment, dated **2026-11-10**, uses source commit
`48e21876d059c226933685dc22b3025ca20b63f2` and rubric v1. Each session performs
a representative source review of all seven KPIs. The coordinator runs the
quality gate separately; evaluators do not execute duplicate checks or live
workloads. This is not a full security audit or live qualification.

| Evaluator | Model identifier | Harness | Reasoning / effort |
| --- | --- | --- | --- |
| Sol | `gpt-6.1-sol` | Codex | `xhigh` |
| Opus | `claude-opus-5-5` | Claude Agent | `high` |
| Sonnet | `claude-sonnet-5-5` | Claude Agent | `high` |
| Grok | `grok-4.7` | Grok | `high` (default) |
| Astra | `gpt-6-astra` | Codex | `xhigh` |

These configurations were requested and accepted by the dispatcher. Completed
sessions reported the selected model and harness as their runtime identity;
underlying provider deployments and application of effort settings were not
independently attested. Opus and Sonnet both failed before returning an assessment
with **Claude API rate limit reached**. They were not replaced or assigned scores.

### Original scores

| KPI | Sol | Opus | Sonnet | Grok | Astra |
| --- | ---: | ---: | ---: | ---: | ---: |
| K1 Architecture and ease of change | 9 | N/A | N/A | 10 | 9 |
| K2 Simplicity and readability | 9 | N/A | N/A | 9 | 9 |
| K3 Test quality | 9 | N/A | N/A | 10 | 9 |
| K4 Reliability and data preservation | 8 | N/A | N/A | 10 | 8 |
| K5 Security | 10 | N/A | N/A | 10 | 10 |
| K6 Developer workflow | 10 | N/A | N/A | 9 | 10 |
| K7 Documentation and terminology | 8 | N/A | N/A | 9 | 9 |

Confidence is **medium** for every completed score except Grok's K1, which is
**high**. N/A means the session was unavailable. These are the original judgments,
preserved after factual review; differences in sampled scope explain some of the
disagreement. In particular, Grok did not identify the draft-image hypothesis
behind Sol's and Astra's K1, K3 and K4 deductions.

### Reviewed conclusions

| KPI | Strengths and remaining blockers to 10 |
| --- | --- |
| K1 | Contracts, authoritative backend operations, Run-store transitions and T3 orchestration have distinct owners. Sol and Astra identified a local metadata/byte-cleanup ownership weakness in draft deletion (F1); Grok found no blocker in its sampled interfaces. |
| K2 | Sampled transitions express domain decisions directly. All three noted retired coordinator terminology on current paths (F2); Grok also proposed simplifying historical SQL, which factual review did not establish as a defect. |
| K3 | Sampled public-operation tests protect recovery, replacement, races and retained history. Sol and Astra identified missing image-byte assertions for stale whole-draft discard (F1); Grok found no blocker in the suites it sampled. |
| K4 | Durable reservations, restart recovery, captured definitions and Archive guards support the documented contract. F1 is a source-supported client-draft preservation hypothesis, not reproduced loss of accepted Run data. Grok found no blocker in its sampled recovery paths. |
| K5 | Sampled host/remote admission, credential, MCP, Origin and desktop TLS/IPC controls enforce their declared trust boundaries. No evaluator identified an unresolved violation within its inspected scope. Dependency advisories and live security remain unassessed. |
| K6 | Pinned tooling, disposable fixtures and the ordered gate support reproducible verification. Sol and Astra found no blocker; Grok deducted for the documented temporary duplicate CI work on PR metadata edits (F4). |
| K7 | The glossary and topic contracts largely match implementation. Current operator guidance contains concrete retired-contract contradictions and a protocol-exception omission (F3). Evaluators differed on which discrepancies they sampled and their impact. |

The coordinator checked the material deductions against the assessed source:

- **F1 — source-supported hypothesis, execution unverified.** In
  [draft deletion](../apps/frontend/src/run-draft.ts), `commit` can preserve
  another tab's unresolved Start while `removeDraft` still removes its image
  bytes through [the image store](../apps/frontend/src/draft-images.ts).
  [Stale-discard tests](../apps/frontend/test/run-draft.test.ts) assert retained
  text and pending metadata; [image tests](../apps/frontend/test/run-draft-images.test.ts)
  protect individual-image removal, a different path. A controlled reproduction
  is needed before calling the reported runtime consequence confirmed.
- **F2 — confirmed source observation.** Current
  [handoff routing](../apps/backend/src/runner/runner-coordinator-handoffs.ts)
  still uses `prepareCoordinatorHandoff`, and
  [execution settings](../apps/frontend/src/components/execution-settings-fields.tsx)
  retain a coordinator role
  whose only caller selects worker. This is obsolete current-path vocabulary;
  reading coordinator history remains an intentional supported contract.
- **F3 — confirmed documentation contradictions.** The
  [live qualification matrix](installation.md#bounded-live-verification) still
  prescribes a `waiting` report, while the
  [current reporting contract](t3-integration.md#factory-mcp-and-block-ids) and runtime reject
  it as `WAITING_RETIRED`. The [security policy](../SECURITY.md) still names Run
  Stop and describes only a project checkout rather than the current workspace
  choices. The [protocol exceptions](desktop-and-clients.md#protocol-compatibility)
  omit the Run-image read exception implemented by the server. These observations
  do not establish an authorization bypass.
- **F4 — confirmed configuration, conditional follow-up.** The quality workflow
  runs the full gate on PR `edited` events. The
  [quality-gate contract](quality-gates.md#ci-and-manual-checks) already explains
  the temporary overlap and its ruleset prerequisite. This is current workflow
  cost, not evidence that removing the check immediately is safe.

The proposed historical SQL rewrite and CONTRIBUTING's prose enumeration of
checks were not established as functional or contract defects; they do not form
an agreed improvement requirement. Original model scores remain unchanged.
No product, test or existing policy fixes were made as part of this baseline.

All evaluator evidence was source-only. Independently, the coordinator ran
`pnpm check` successfully on the same product source with only this documentation
change pending, and checked local documentation links and diff whitespace.
Those results were not supplied to the independent evaluators or used to rewrite
their scores. E2E journeys, rendered UI, native packaging, live T3, cross-device
operation and dependency advisories were not executed or qualified by this round.
