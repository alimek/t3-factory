import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../ids.ts";
import { now } from "../time.ts";
import type { ReportConsumer, ReportOrigin, RunReport } from "./run-reports.ts";
import { runReference } from "./run-tools.ts";

/** Discord's message length; a card or notice always fits one message. */
export const MESSAGE_LIMIT = 2000;
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
export const inert = (text: string) => text.replaceAll("@", "@\u200b");
export const name = (text: string | null | undefined) =>
  inert(clip(text ?? "Unnamed Block", NAME_LIMIT));
const runTitle = (text: string) => inert(clip(text, TITLE_LIMIT));
/** A card's or notice's bold Run line start: reference and title. */
export const runHeading = (reference: string, title: string) =>
  `**Run ${reference} · ${runTitle(title)}**`;
/**
 * A relative Discord timestamp ("in 5 minutes", "2 hours ago"): every reader's client renders it
 * in their own time zone, with the exact time on hover.
 */
export const at = (iso: string) => `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;

/** How every Chat control message shows a Run's lifecycle. */
export const LIFECYCLE: Record<RunReport["run"]["state"], string> = {
  active: "🟢 Active",
  snoozed: "💤 Snoozed",
  settled: "✅ Settled",
  archived: "🗄️ Archived",
};
type Block = RunReport["blocks"][number];

const PROBLEMS: Partial<Record<NonNullable<Block["problem"]>, string>> = {
  "missing-report": "report missing",
  "execution-failed": "execution failed",
  "report-problem": "report problem",
  "condition-integrity": "Condition cannot number its next arrival",
  "settlement-unresolved": "Settle could not stop workers",
};

const STOPPING = "⏹️ Settle confirmed: Factory is stopping this Run's workers.";
const UNRESOLVED = "⚠️ Settle confirmed, but some workers could not be confirmed stopped.";
const oneLine = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, " ");

function blockStatus(block: Block) {
  const label = name(oneLine(block.name));
  if (block.problem !== null) return `⚠️ **${label}** — ${PROBLEMS[block.problem] ?? "problem"}`;
  if (block.needsInput !== null)
    return `🙋 **${label}** — needs input${block.needsInput === "T3" ? " (answer in T3)" : ""}`;
  if (block.wait)
    return `⏰ ${label} — waits until ${at(block.wait.deadlineAt)}${block.wait.count > 1 ? ` · ${block.wait.count} waiting` : ""}`;
  switch (block.state) {
    case "working":
      return `⚙️ **${label}** — working`;
    case "sent":
      return `⚙️ **${label}** — Continuation sent`;
    case "waiting":
      return `⏳ ${label} — waiting`;
    case "stopped":
      return `⏹️ ${label} — stopped`;
    case "finished":
    case "pass-through":
      return `✅ ${label} — finished`;
    case "error":
      return `⚠️ **${label}** — problem`;
    case "not-started":
      return `○ ${label} — not started`;
  }
}

function observation(block: Block) {
  if (block.observation === "stale") return " · observation stale";
  if (
    block.observation === "unknown" &&
    (block.state === "working" ||
      block.state === "sent" ||
      block.needsInput === "T3" ||
      (block.problem !== null && (block.kind === "agent" || block.kind === "continuation")))
  )
    return " · not observed yet";
  return "";
}

function collapseRows(rows: string[], icon: string, state: string) {
  const grouped = rows.filter((row) => row.startsWith(`${icon} `));
  const remaining = rows.filter((row) => !row.startsWith(`${icon} `));
  const summary = new RegExp(`^${icon} \\d+ Blocks? ${state}$`);
  const count = grouped.length;
  return {
    remaining,
    summary: count
      ? [
          grouped.find((row) => summary.test(row)) ??
            `${icon} ${count} Block${count === 1 ? "" : "s"} ${state}`,
        ]
      : [],
  };
}

function fitRemainingRows(head: string[], rows: string[], tail: string[]) {
  const priorOmission = /^… and (\d+) more Blocks$/.exec(rows.at(-1) ?? "");
  const alreadyOmitted = priorOmission ? Number(priorOmission[1]) : 0;
  const shown = priorOmission ? rows.slice(0, -1) : rows;
  let length = [...head, ...tail].join("\n").length;
  for (const [index, row] of shown.entries()) {
    length += row.length + 1;
    const omitted = shown.length - index + alreadyOmitted;
    const overflow = `… and ${omitted} more Blocks`;
    const reserve = omitted > 1 ? overflow.length + 1 : 0;
    if (length + reserve > MESSAGE_LIMIT)
      return [...head, ...shown.slice(0, index), overflow, ...tail].join("\n");
  }
  return [
    ...head,
    ...shown,
    ...(alreadyOmitted > 0 ? [`… and ${alreadyOmitted} more Blocks`] : []),
    ...tail,
  ].join("\n");
}

function fitCard(head: string[], rows: string[]) {
  const full = [...head, ...rows].join("\n");
  if (full.length <= MESSAGE_LIMIT) return full;

  const notStarted = collapseRows(rows, "○", "not started");
  const compact = [...head, ...notStarted.remaining, ...notStarted.summary].join("\n");
  if (compact.length <= MESSAGE_LIMIT) return compact;

  const finished = collapseRows(notStarted.remaining, "✅", "finished");
  return fitRemainingRows([...head, ...finished.summary], finished.remaining, notStarted.summary);
}

function statusCardText(report: RunReport, replacedApplication: boolean) {
  const { run } = report;
  const head = [
    ...(replacedApplication ? [`_${APPLICATION_NOTICE}_`, ""] : []),
    `${runHeading(runReference(run), oneLine(run.title))} · ${LIFECYCLE[run.state]} · 🔀 ${name(oneLine(run.flow))}`,
    ...(report.settlement === null
      ? []
      : [report.settlement === "stopping" ? STOPPING : UNRESOLVED]),
  ];
  return fitCard(
    head,
    report.blocks.map((block) => `${blockStatus(block)}${observation(block)}`),
  );
}

/** A card that replaces another application's card carries the notice once, as its first line. */
export function withApplicationNotice(text: string) {
  if (text.startsWith(`_${APPLICATION_NOTICE}_`)) return text;
  const [heading, ...rows] = text.split("\n");
  const head = [`_${APPLICATION_NOTICE}_`, "", heading!];
  if (rows[0] === STOPPING || rows[0] === UNRESOLVED) head.push(rows.shift()!);
  return fitCard(head, rows);
}

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
      const id = yield* insertCard(origin, report, text);
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
        const [current] =
          yield* sql<CardDeliveryRow>`SELECT id,state,text,message_id,sent_by_application_id FROM chat_deliveries WHERE id=${card.delivery_id}`;
        const reportable = reportableNow(report);
        const text = statusCardText(
          report,
          current!.state === "retired" || card.replaced_application_id !== null,
        );
        const state =
          current!.state === "retired"
            ? yield* renewRetired(origin, report, current!, text)
            : yield* updateCard(current!, text, reportable);
        const final = report.run.state === "archived" && SETTLED_STATES.has(state);
        yield* sql`UPDATE chat_status_cards SET reportable=${reportable ? 1 : 0},final=${final ? 1 : 0} WHERE run_id=${origin.runId}`;
      }),
  };
};
