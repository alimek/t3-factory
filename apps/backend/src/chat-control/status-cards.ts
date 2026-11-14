import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../ids.ts";
import { now } from "../time.ts";
import type { ReportConsumer, ReportOrigin, RunReport } from "./run-reports.ts";
import { runReference } from "./run-tools.ts";

/** Discord's message length; a card or notice always fits one message. */
export const MESSAGE_LIMIT = 2000;
/** Entries each card list shows before summarizing the rest, shrunk until the card fits. */
const LIST_LIMITS = [8, 4, 2, 1, 0] as const;
const NAME_LIMIT = 100;
const TITLE_LIMIT = 200;

/** The first line of a card that replaced another application's cards in its thread. */
const APPLICATION_NOTICE =
  "Factory's Discord application changed. Messages the previous bot posted in this thread are no longer updated; this card replaces its status card.";

export const clip = (text: string, limit: number) => {
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
};
/**
 * Names come from users, so a zero-width space follows every `@`: no name can read as a user,
 * role or mass mention, independently of the allowed mentions every Factory message sends.
 */
const inert = (text: string) => text.replaceAll("@", "@\u200b");
export const name = (text: string | null | undefined) =>
  inert(clip(text ?? "Unnamed Block", NAME_LIMIT));
const runTitle = (text: string) => inert(clip(text, TITLE_LIMIT));
/** A card's or notice's bold Run line start: reference and title. */
export const runHeading = (reference: string, title: string) =>
  `**Run ${reference} · ${runTitle(title)}**`;
/** A Discord timestamp: every reader sees it in their own time zone. */
export const at = (iso: string) => `<t:${Math.floor(Date.parse(iso) / 1000)}:f>`;

const STATES: Record<RunReport["run"]["state"], string> = {
  active: "Active",
  snoozed: "Snoozed",
  settled: "Settled",
  archived: "Archived",
};
const ACTIVE_BLOCKS = new Set(["working", "waiting", "sent"]);
const BLOCK_STATES: Record<string, string> = {
  working: "working",
  waiting: "waiting",
  sent: "Continuation sent",
};
const OBSERVATIONS: Record<string, string> = {
  stale: " · observation stale",
  unknown: " · not observed yet",
};
const HANDOFFS: Record<string, (to: string) => string> = {
  delivered: (to) => `handed off to ${to}`,
  cancelled: (to) => `handoff to ${to} cancelled`,
  "released-unconfirmed": (to) => `released to ${to}, delivery not confirmed yet`,
  held: (to) => `handoff to ${to} held`,
};
const NEEDS_INPUT: Record<string, string> = {
  human: "Human step",
  "native-request": "T3 request, answer it in T3",
  "conversation-waiting": "Agent question",
};
const PROBLEMS: Record<string, string> = {
  "missing-report": "report missing",
  "execution-failed": "execution failed",
  "report-problem": "report problem",
};

function resultLine(result: RunReport["latestResults"][number]) {
  const parts = [
    `${name(result.block)}: ${result.status === "finished" ? "finished" : "reported waiting"}${
      result.exit ? ` via “${name(result.exit)}”` : ""
    }, accepted ${at(result.acceptedAt)}`,
  ];
  if (result.workerCompletion === "confirmed") parts.push("worker finished");
  if (result.workerCompletion === "held") parts.push("worker not confirmed finished");
  for (const handoff of result.handoffs) parts.push(HANDOFFS[handoff.state]!(name(handoff.to)));
  return parts.join(" · ");
}

/** A titled list of at most `limit` lines, summarizing the rest; nothing when empty. */
function section(title: string, lines: readonly string[], limit: number) {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, limit).map((line) => `• ${line}`);
  const rest = lines.length - shown.length;
  return [`**${title}**`, ...shown, ...(rest > 0 ? [`• and ${rest} more`] : [])];
}

/**
 * A Run's status card: identity, lifecycle, active Blocks, the latest result of each Block, pending
 * Waits with deadlines, Needs input and Problems, from Factory's own facts. It never carries
 * report bodies or prompts, and always fits one Discord message: long lists are summarized and
 * the card points to Read Run for everything.
 */
function statusCardText(report: RunReport, replacedApplication: boolean) {
  const { run } = report;
  const reference = runReference(run);
  const head = [
    ...(replacedApplication ? [`_${APPLICATION_NOTICE}_`, ""] : []),
    `${runHeading(reference, run.title)} · ${STATES[run.state]}`,
    `Project: ${name(run.project.name)} (\`${clip(run.project.repositoryPath, TITLE_LIMIT)}\`) · Flow: ${name(run.flow)}`,
    ...(report.settlement === null
      ? []
      : [
          report.settlement === "stopping"
            ? "Settle confirmed: Factory is stopping this Run's workers."
            : "Settle confirmed, but some workers could not be confirmed stopped.",
        ]),
  ];
  const blocks = report.blocks
    .filter((block) => ACTIVE_BLOCKS.has(block.state))
    .map(
      (block) =>
        `${name(block.name)}: ${BLOCK_STATES[block.state]}${OBSERVATIONS[block.observation] ?? ""}`,
    );
  const results = report.latestResults.map(resultLine);
  const waits = report.pendingWaits.map(
    (wait) => `${name(wait.block)}: until ${at(wait.deadlineAt)}`,
  );
  const needsInput = report.needsInput.map(
    (matter) =>
      `${NEEDS_INPUT[matter.kind]} in ${name(matter.block)} since ${at(matter.appearedAt)}${
        OBSERVATIONS[matter.observation] ?? ""
      }`,
  );
  const problems = report.problems.map(
    (matter) =>
      `${name(matter.block)}: ${PROBLEMS[matter.kind]} since ${at(matter.appearedAt)}${
        OBSERVATIONS[matter.observation] ?? ""
      }`,
  );
  const foot = `Factory keeps this card current. Ask Factory to read Run ${reference} for results and details.`;
  const render = (limit: number) =>
    [
      ...head,
      ...section("Active Blocks", blocks, limit),
      ...section("Latest results", results, limit),
      ...section("Waiting", waits, limit),
      ...section("Needs input", needsInput, limit),
      ...section("Problems", problems, limit),
      foot,
    ].join("\n");
  for (const limit of LIST_LIMITS) {
    const text = render(limit);
    if (text.length <= MESSAGE_LIMIT) return text;
  }
  return clip(render(0), MESSAGE_LIMIT);
}

/** A card that replaces another application's card carries the notice once, as its first line. */
export const withApplicationNotice = (text: string) =>
  text.startsWith(`_${APPLICATION_NOTICE}_`) ? text : `_${APPLICATION_NOTICE}_\n\n${text}`;

type CardRow = {
  delivery_id: string;
  replaced_application_id: string | null;
};

type CardDeliveryRow = {
  id: string;
  state: "owed" | "sending" | "delivered" | "failed" | "unknown" | "cancelled" | "lost" | "retired";
  text: string;
  message_id: string | null;
  sent_by_application_id: string | null;
};

/** Card message states in which nothing more is owed. */
const SETTLED_STATES = new Set<CardDeliveryRow["state"]>(["delivered", "retired", "cancelled"]);

/**
 * The state a card's message record moves to for `text`. A cancelled card is current again once
 * its channel grants the Run once more: a known message is corrected silently, and a card never
 * created is created only if the Run warrants one. Other states keep their state and take the text.
 */
function nextState(current: CardDeliveryRow, text: string, reportable: boolean) {
  if (current.state !== "delivered" && current.state !== "cancelled") return current.state;
  if (current.message_id !== null) return current.text === text ? "delivered" : "owed";
  return reportable ? "owed" : current.state;
}

/** Whether a Run warrants a card now: Active or Snoozed, or with pending attention. */
const reportableNow = (report: RunReport) =>
  report.run.state === "active" ||
  report.run.state === "snoozed" ||
  report.needsInput.length > 0 ||
  report.problems.length > 0;

/**
 * The status card's capture: one maintained card per chat-started Run, owed from the first
 * capture after Start and kept equal to the Run's current report. A delivered card owes an edit
 * whenever its text changes; an owed or uncertain card simply carries the newest text. After a
 * revocation the card accrues nothing; once its channel grants the Run again, a known card is
 * corrected silently and a never-created one is created only while the Run warrants a card.
 */
export const statusCards = (sql: SqlClient.SqlClient): ReportConsumer => {
  const insertCard = (origin: ReportOrigin, report: RunReport, text: string) =>
    Effect.gen(function* () {
      const id = yield* newId;
      const createdAt = yield* now;
      const { destination } = origin;
      yield* sql`INSERT INTO chat_deliveries (id,purpose,run_id,guild_id,parent_channel_id,thread_id,project_ids_json,text,state,created_at)
        VALUES (${id},'status-card',${origin.runId},${destination.guildId},${destination.parentChannelId},${destination.threadId},
          ${JSON.stringify([report.run.project.id])},${text},'owed',${createdAt})`;
      return id;
    });

  /** Creates the Run's first card, owed since its Start whatever the Run's state now. */
  const firstCard = (origin: ReportOrigin, report: RunReport) =>
    Effect.gen(function* () {
      const id = yield* insertCard(origin, report, statusCardText(report, false));
      yield* sql`INSERT INTO chat_status_cards (run_id,delivery_id,reportable) VALUES (${origin.runId},${id},${reportableNow(report) ? 1 : 0})`;
    });

  /** Brings the card's current message record to `text`. */
  const updateCard = (current: CardDeliveryRow, text: string, reportable: boolean) =>
    Effect.gen(function* () {
      const state = nextState(current, text, reportable);
      if (state !== current.state)
        yield* sql`UPDATE chat_deliveries SET text=${text},state=${state},next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${current.id}`;
      else if (current.text !== text)
        yield* sql`UPDATE chat_deliveries SET text=${text} WHERE id=${current.id}`;
      return state;
    });

  /** A retired card's application no longer serves; a Run warranting a card gets a new one. */
  const renewRetired = (
    origin: ReportOrigin,
    report: RunReport,
    current: CardDeliveryRow,
    text: string,
  ) =>
    Effect.gen(function* () {
      if (!reportableNow(report)) return current.state;
      const id = yield* insertCard(origin, report, withApplicationNotice(text));
      yield* sql`UPDATE chat_status_cards SET delivery_id=${id},replaced_application_id=${current.sent_by_application_id} WHERE run_id=${origin.runId}`;
      return "owed" as const;
    });

  return {
    capture: (origin, report) =>
      Effect.gen(function* () {
        if (!report) return;
        const [card] =
          yield* sql<CardRow>`SELECT delivery_id,replaced_application_id FROM chat_status_cards WHERE run_id=${origin.runId}`;
        if (!card) return yield* firstCard(origin, report);
        const text = statusCardText(report, card.replaced_application_id !== null);
        const [current] =
          yield* sql<CardDeliveryRow>`SELECT id,state,text,message_id,sent_by_application_id FROM chat_deliveries WHERE id=${card.delivery_id}`;
        const reportable = reportableNow(report);
        const state =
          current!.state === "retired"
            ? yield* renewRetired(origin, report, current!, text)
            : yield* updateCard(current!, text, reportable);
        const final = report.run.state === "archived" && SETTLED_STATES.has(state);
        yield* sql`UPDATE chat_status_cards SET reportable=${reportable ? 1 : 0},final=${final ? 1 : 0} WHERE run_id=${origin.runId}`;
      }),
  };
};

/**
 * The Run a message identifies: a status card this application posted in this thread. Only the
 * Run ID is returned; the card's content is never read back.
 */
export const publishedRun =
  (sql: SqlClient.SqlClient, applicationId: string) => (threadId: string, messageId: string) =>
    Effect.map(
      sql<{ run_id: string }>`SELECT run_id FROM chat_deliveries WHERE purpose='status-card'
        AND thread_id=${threadId} AND message_id=${messageId} AND sent_by_application_id=${applicationId}`,
      ([row]) => row?.run_id,
    );
