import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { newId } from "../ids.ts";
import { now } from "../time.ts";
import type { ReportConsumer, ReportOrigin, RunReport } from "./run-reports.ts";
import { runReference } from "./run-tools.ts";
import { at, clip, MESSAGE_LIMIT, name, runHeading } from "./status-cards.ts";

type Lifecycle = "active" | "settled" | "archived";
type MatterKind = RunReport["needsInput"][number]["kind"];
/** A pending attention matter as a report lists it. */
type Matter = Pick<RunReport["needsInput"][number], "id" | "kind" | "block" | "appearedAt">;
type NoticePurpose = "attention" | "lifecycle" | "catch-up";
type DeliveryState =
  | "owed"
  | "sending"
  | "delivered"
  | "failed"
  | "unknown"
  | "cancelled"
  | "lost"
  | "retired";

/** Snooze changes presentation only, so a Snoozed Run counts as Active for notices. */
const lifecycleOf = (state: RunReport["run"]["state"]): Lifecycle =>
  state === "snoozed" ? "active" : state;

/** Matters one attention notice lists, so each keeps its own line within one Discord message. */
const MATTERS_PER_NOTICE = 8;
/** Entries a catch-up lists before summarizing the rest, shrunk until it fits one message. */
const CATCH_UP_LIMITS = [Infinity, 8, 4, 2, 1, 0] as const;

const NEEDS_INPUT = new Set<MatterKind>(["human", "native-request", "conversation-waiting"]);

/** What each matter is, and while pending, where it is answered. */
const MATTERS: Record<MatterKind, { what: (block: string) => string; pending?: string }> = {
  human: {
    what: (block) => `Human step ${block} waits for an answer`,
    pending: "ask here to review it; answering needs your confirmation",
  },
  "native-request": {
    what: (block) => `${block} has a T3 request`,
    pending: "answer it in T3",
  },
  "conversation-waiting": { what: (block) => `${block} asked a question` },
  "missing-report": { what: (block) => `${block}: report missing` },
  "execution-failed": { what: (block) => `${block}: execution failed` },
  "report-problem": { what: (block) => `${block}: report problem` },
};

const LIFECYCLE_EMOJI: Record<Lifecycle, string> = { active: "🟢", settled: "✅", archived: "🗄️" };
const LIFECYCLE_SENTENCES: Record<Lifecycle, string> = {
  active: "is Active again",
  settled: "is Settled",
  archived: "was Archived",
};
const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  active: "🟢 Active again",
  settled: "✅ Settled",
  archived: "🗄️ Archived",
};

const APPLICATION_NOTICE =
  "_Factory's Discord application changed. Messages the previous bot posted in this thread are no longer updated._";

type MatterRow = {
  matter_id: string;
  kind: MatterKind;
  block: string;
  appeared_at: string;
  resolved: number;
};

type NoticeRow = {
  delivery_id: string;
  run_id: string;
  lifecycle: Lifecycle | null;
  previous_lifecycle: Lifecycle | null;
  lifecycle_at: string | null;
  late: number;
  application_notice: number;
  purpose: NoticePurpose;
  state: DeliveryState;
  text: string;
  message_id: string | null;
  created_at: string;
  reference: string;
  title: string;
};

const matterLine = (matter: MatterRow) => {
  const kind = MATTERS[matter.kind];
  const what = `${kind.what(name(matter.block))} · since ${at(matter.appeared_at)}`;
  if (matter.resolved === 1) return `• ~~${what}~~ ✅`;
  return `• ${what}${kind.pending ? ` — ${kind.pending}` : ""}`;
};

/** An attention notice's first line: an emoji for its kind of matters, the Run and what it has. */
function attentionHeading(heading: string, matters: readonly MatterRow[]) {
  const needsInput = matters.filter((matter) => NEEDS_INPUT.has(matter.kind)).length;
  const [emoji, subject] =
    needsInput === matters.length
      ? ["🙋", "needs input"]
      : needsInput === 0
        ? ["⚠️", matters.length === 1 ? "has a Problem" : "has Problems"]
        : ["🔔", "needs attention"];
  const resolved = matters.every((matter) => matter.resolved === 1) ? " · ✅ resolved" : "";
  return `${emoji} ${heading} ${subject}${resolved}`;
}

/**
 * A notice's text from what it records: the matters it announced (resolved ones shown struck
 * through once the message exists, left out before), the lifecycle change it reports, and for a
 * catch-up, that it reports what happened while Factory could not post here. Nobody is mentioned
 * and every name is inert.
 */
function noticeText(notice: NoticeRow, matters: readonly MatterRow[]) {
  const heading = runHeading(notice.reference, notice.title);
  const intro = notice.application_notice === 1 ? [APPLICATION_NOTICE, ""] : [];
  const late = notice.late === 1 ? ", delivered late" : "";
  const lifecycleLine =
    notice.lifecycle === null
      ? []
      : [`• ${LIFECYCLE_LABELS[notice.lifecycle]} ${at(notice.lifecycle_at!)}${late}`];
  const render = (limit: number) => {
    const lines = matters.slice(0, limit).map(matterLine);
    const rest = matters.length - lines.length;
    if (rest > 0) lines.push(`• and ${rest} more; the status card shows what is pending`);
    switch (notice.purpose) {
      case "attention":
        return [...intro, attentionHeading(heading, matters), ...lines];
      case "lifecycle":
        return [
          ...intro,
          `${LIFECYCLE_EMOJI[notice.lifecycle!]} ${heading} ${LIFECYCLE_SENTENCES[notice.lifecycle!]} ${at(notice.lifecycle_at!)}`,
        ];
      case "catch-up":
        return [
          ...intro,
          `📬 ${heading} · while Factory could not post in this thread:`,
          ...lifecycleLine,
          ...lines,
        ];
    }
  };
  for (const limit of CATCH_UP_LIMITS) {
    const text = render(limit).join("\n");
    if (text.length <= MESSAGE_LIMIT) return text;
  }
  return clip(render(0).join("\n"), MESSAGE_LIMIT);
}

/**
 * The state a notice's message record moves to for `text`. A message that exists owes an edit
 * when its text changes, and a cancelled one is corrected silently once its channel grants the
 * Run again. A message never created that has nothing left to say retires: a matter resolved or a
 * lifecycle change undone before it was posted is not reported. Other states take the text.
 */
function nextState(notice: NoticeRow, text: string, obsolete: boolean): DeliveryState {
  if (notice.message_id !== null) {
    if (notice.state !== "delivered" && notice.state !== "cancelled") return notice.state;
    return notice.text === text ? "delivered" : "owed";
  }
  return obsolete && ["owed", "failed", "unknown"].includes(notice.state)
    ? "retired"
    : notice.state;
}

const NOTICE_COLUMNS = `n.delivery_id,n.run_id,n.lifecycle,n.previous_lifecycle,n.lifecycle_at,n.late,
  n.application_notice,d.purpose,d.state,d.text,d.message_id,d.created_at,r.reference,r.title`;

/** Brings one notice's message record to the text its current records render. */
const refreshNotice = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const [notice] = yield* sql<NoticeRow>`SELECT ${sql.literal(NOTICE_COLUMNS)}
      FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
      JOIN chat_run_reporting r ON r.run_id=n.run_id WHERE n.delivery_id=${id}`;
    const all = yield* sql<MatterRow>`SELECT matter_id,kind,block,appeared_at,resolved
      FROM chat_report_matters WHERE notice_id=${id} ORDER BY appeared_at,matter_id`;
    const announced = notice!.message_id !== null || notice!.state === "sending";
    const matters = announced ? all : all.filter((matter) => matter.resolved === 0);
    const obsolete = notice!.lifecycle === null && matters.length === 0;
    const text = obsolete ? notice!.text : noticeText(notice!, matters);
    const state = nextState(notice!, text, obsolete);
    if (state !== notice!.state)
      yield* sql`UPDATE chat_deliveries SET text=${text},state=${state},next_attempt_at=NULL,problem=NULL,problem_at=NULL WHERE id=${id}`;
    else if (text !== notice!.text)
      yield* sql`UPDATE chat_deliveries SET text=${text} WHERE id=${id}`;
  });

/** A notice message never created and not being sent: new content may still join it. */
const OPEN = "d.state='owed' AND d.message_id IS NULL";

type ReportingRow = { lifecycle: Lifecycle | null };

/**
 * Attention and lifecycle notices: new messages in a chat-started Run's originating thread for
 * each new Needs input or Problem matter, for becoming Settled or Archived and for returning to
 * Active. Each capture compares the Run's pending matters and lifecycle with what notices
 * accounted for, so a matter that appeared and resolved between two captures, or a lifecycle
 * change undone, is never reported. Matters appearing together share one notice, each on its own
 * line; a resolved matter edits the notice that announced it. While the thread's channel does not
 * grant the Run nothing accrues; the first capture after a regrant takes the Run's current state
 * as its baseline without a message, and known messages are corrected silently.
 */
export const reportNotices = (sql: SqlClient.SqlClient): ReportConsumer => {
  const insertNotice = (origin: ReportOrigin, report: RunReport, purpose: NoticePurpose) =>
    Effect.gen(function* () {
      const id = yield* newId;
      const createdAt = yield* now;
      const { destination } = origin;
      yield* sql`INSERT INTO chat_deliveries (id,purpose,run_id,guild_id,parent_channel_id,thread_id,project_ids_json,text,state,created_at)
        VALUES (${id},${purpose},${origin.runId},${destination.guildId},${destination.parentChannelId},${destination.threadId},
          ${JSON.stringify([report.run.project.id])},'','owed',${createdAt})`;
      yield* sql`INSERT INTO chat_report_notices (delivery_id,run_id) VALUES (${id},${origin.runId})`;
      return id;
    });

  const insertMatters = (runId: string, noticeId: string | null, matters: readonly Matter[]) =>
    Effect.forEach(
      matters,
      (matter) =>
        sql`INSERT INTO chat_report_matters (matter_id,run_id,notice_id,kind,block,appeared_at)
          VALUES (${matter.id},${runId},${noticeId},${matter.kind},${matter.block},${matter.appearedAt})`,
      { discard: true },
    );

  /**
   * Announces new matters: they join a notice of the Run not posted yet while it has room,
   * otherwise new attention notices list them, at most a fixed number each. Returns the notices.
   */
  const announce = (origin: ReportOrigin, report: RunReport, fresh: readonly Matter[]) =>
    Effect.gen(function* () {
      const notices: string[] = [];
      let queue = fresh;
      const [open] = yield* sql<{ id: string; purpose: NoticePurpose; count: number }>`
        SELECT d.id,d.purpose,(SELECT COUNT(*) FROM chat_report_matters m WHERE m.notice_id=d.id) AS count
        FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${origin.runId} AND ${sql.literal(OPEN)} AND d.purpose IN ('attention','catch-up')
        ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1`;
      if (open) {
        const room = open.purpose === "catch-up" ? queue.length : MATTERS_PER_NOTICE - open.count;
        yield* insertMatters(origin.runId, open.id, queue.slice(0, room));
        if (room > 0) notices.push(open.id);
        queue = queue.slice(room);
      }
      while (queue.length > 0) {
        const id = yield* insertNotice(origin, report, "attention");
        yield* insertMatters(origin.runId, id, queue.slice(0, MATTERS_PER_NOTICE));
        notices.push(id);
        queue = queue.slice(MATTERS_PER_NOTICE);
      }
      return notices;
    });

  /**
   * Reports a lifecycle change: a lifecycle notice not posted yet takes the newest change, and
   * reports none when the Run is back to what was accounted for before it; otherwise a new
   * lifecycle notice reports it.
   */
  const lifecycleChanged = (
    origin: ReportOrigin,
    report: RunReport,
    accounted: Lifecycle,
    current: Lifecycle,
  ) =>
    Effect.gen(function* () {
      const [open] = yield* sql<{ id: string; previous_lifecycle: Lifecycle | null }>`
        SELECT d.id,n.previous_lifecycle FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${origin.runId} AND ${sql.literal(OPEN)} AND d.purpose IN ('lifecycle','catch-up')
        ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1`;
      const id = open?.id ?? (yield* insertNotice(origin, report, "lifecycle"));
      const previous = open?.previous_lifecycle ?? accounted;
      if (previous === current)
        yield* sql`UPDATE chat_report_notices SET lifecycle=NULL,previous_lifecycle=NULL,lifecycle_at=NULL WHERE delivery_id=${id}`;
      else
        yield* sql`UPDATE chat_report_notices SET lifecycle=${current},previous_lifecycle=${previous},
          lifecycle_at=${report.lifecycleAt} WHERE delivery_id=${id}`;
      return id;
    });

  /** Whether an Archived Run's notices owe nothing more, so later captures can skip it. */
  const finished = (runId: string) =>
    Effect.map(
      sql<{
        owing: number;
      }>`SELECT COUNT(*) AS owing FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${runId} AND (d.state IN ('owed','sending','failed','unknown')
          OR (d.state='cancelled' AND d.message_id IS NOT NULL))`,
      ([row]) => row!.owing === 0,
    );

  /**
   * Records how the Run is named now and returns what its notices accounted for: the first
   * capture after Start reports from Active, and a NULL lifecycle asks for a baseline.
   */
  const accounting = (runId: string, report: RunReport) =>
    Effect.gen(function* (): Effect.fn.Return<
      { readonly baseline: boolean; readonly accounted: Lifecycle },
      unknown
    > {
      const reference = runReference(report.run);
      const [row] =
        yield* sql<ReportingRow>`SELECT lifecycle FROM chat_run_reporting WHERE run_id=${runId}`;
      if (!row) {
        yield* sql`INSERT INTO chat_run_reporting (run_id,lifecycle,reference,title) VALUES (${runId},'active',${reference},${report.run.title})`;
        return { baseline: false, accounted: "active" };
      }
      yield* sql`UPDATE chat_run_reporting SET reference=${reference},title=${report.run.title} WHERE run_id=${runId}`;
      return { baseline: row.lifecycle === null, accounted: row.lifecycle ?? "active" };
    });

  /**
   * Marks matters no longer pending resolved and records new ones: announced, or at a baseline
   * only shown on the card. Returns the notices whose text changed.
   */
  const capturedMatters = (origin: ReportOrigin, report: RunReport, baseline: boolean) =>
    Effect.gen(function* () {
      const pending = [...report.needsInput, ...report.problems];
      const pendingIds = new Set(pending.map((matter) => matter.id));
      const known = yield* sql<{
        matter_id: string;
        notice_id: string | null;
        resolved: number;
      }>`SELECT matter_id,notice_id,resolved FROM chat_report_matters WHERE run_id=${origin.runId}`;
      const resolved = known.filter(
        (matter) => matter.resolved === 0 && !pendingIds.has(matter.matter_id),
      );
      if (resolved.length > 0)
        yield* sql`UPDATE chat_report_matters SET resolved=1 WHERE matter_id IN ${sql.in(resolved.map((matter) => matter.matter_id))}`;
      const knownIds = new Set(known.map((matter) => matter.matter_id));
      const fresh = pending.filter((matter) => !knownIds.has(matter.id));
      const announced = baseline
        ? yield* Effect.as(insertMatters(origin.runId, null, fresh), [])
        : yield* announce(origin, report, fresh);
      return [...resolved.flatMap((matter) => matter.notice_id ?? []), ...announced];
    });

  /** Notice messages whose edits a revocation cancelled, corrected once the channel grants again. */
  const cancelledMessages = (runId: string) =>
    Effect.map(
      sql<{ delivery_id: string }>`SELECT n.delivery_id FROM chat_report_notices n
        JOIN chat_deliveries d ON d.id=n.delivery_id
        WHERE n.run_id=${runId} AND d.state='cancelled' AND d.message_id IS NOT NULL`,
      (rows) => rows.map((row) => row.delivery_id),
    );

  return {
    capture: (origin, report) =>
      Effect.gen(function* () {
        if (!report) return;
        const { runId } = origin;
        const current = lifecycleOf(report.run.state);
        const { baseline, accounted } = yield* accounting(runId, report);
        const touched = new Set(yield* capturedMatters(origin, report, baseline));
        const changed = current !== accounted;
        if (changed && !baseline)
          touched.add(yield* lifecycleChanged(origin, report, accounted, current));
        if (changed || baseline)
          yield* sql`UPDATE chat_run_reporting SET lifecycle=${current} WHERE run_id=${runId}`;
        for (const id of yield* cancelledMessages(runId)) touched.add(id);
        for (const id of touched) yield* refreshNotice(sql, id);
        const final = current === "archived" && (yield* finished(runId));
        yield* sql`UPDATE chat_run_reporting SET final=${final ? 1 : 0} WHERE run_id=${runId}`;
      }),
  };
};

/**
 * Whether the Run's card is another application's message that gets no replacement, because the
 * Run is quiet: its catch-up then says that the old bot's messages are no longer updated.
 */
const orphanedCard = (sql: SqlClient.SqlClient, runId: string, applicationId: string) =>
  Effect.map(
    sql<{ orphaned: number }>`SELECT COUNT(*) AS orphaned FROM chat_status_cards c
      JOIN chat_deliveries d ON d.id=c.delivery_id WHERE c.run_id=${runId} AND c.reportable=0
        AND d.message_id IS NOT NULL AND d.sent_by_application_id<>${applicationId}`,
    ([row]) => row!.orphaned > 0,
  );

/** The latest lifecycle change of `notices`, unless the Run is back to what preceded the first. */
function netChange(notices: readonly NoticeRow[]) {
  const changes = notices.filter((notice) => notice.lifecycle !== null);
  const latest = changes.at(-1);
  const previous = changes[0]?.previous_lifecycle ?? null;
  return latest && latest.lifecycle !== previous
    ? { lifecycle: latest.lifecycle, at: latest.lifecycle_at, previous }
    : { lifecycle: null, at: null, previous: null };
}

/** Merges a Run's never-created notices into one catch-up, which reports their content late. */
const mergedCatchUp = (
  sql: SqlClient.SqlClient,
  notices: readonly NoticeRow[],
  applicationId: string,
) =>
  Effect.gen(function* () {
    const target = notices.find((notice) => notice.purpose === "catch-up") ?? notices[0]!;
    const others = notices
      .filter((notice) => notice !== target)
      .map((notice) => notice.delivery_id);
    if (others.length > 0) {
      yield* sql`UPDATE chat_report_matters SET notice_id=${target.delivery_id} WHERE notice_id IN ${sql.in(others)}`;
      yield* sql`DELETE FROM chat_report_notices WHERE delivery_id IN ${sql.in(others)}`;
      yield* sql`DELETE FROM chat_deliveries WHERE id IN ${sql.in(others)}`;
    }
    const change = netChange(notices);
    const orphaned = yield* orphanedCard(sql, target.run_id, applicationId);
    yield* sql`UPDATE chat_deliveries SET purpose='catch-up' WHERE id=${target.delivery_id}`;
    yield* sql`UPDATE chat_report_notices SET lifecycle=${change.lifecycle},previous_lifecycle=${change.previous},
      lifecycle_at=${change.at},late=1,application_notice=${orphaned ? 1 : 0} WHERE delivery_id=${target.delivery_id}`;
    yield* refreshNotice(sql, target.delivery_id);
  });

/**
 * Coalesces what accrued while no session served into one catch-up per Run, when a session
 * starts serving: every notice of the Run never created merges into one, which reports its
 * pending matters and its latest lifecycle change as delivered late. A notice whose message may
 * exist, or that waits for the host's Retry, is left as it is.
 */
export const catchUpNotices = (sql: SqlClient.SqlClient, applicationId: string) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const owed = yield* sql<NoticeRow>`SELECT ${sql.literal(NOTICE_COLUMNS)}
        FROM chat_report_notices n JOIN chat_deliveries d ON d.id=n.delivery_id
        JOIN chat_run_reporting r ON r.run_id=n.run_id WHERE ${sql.literal(OPEN)}
        ORDER BY d.created_at,d.rowid`;
      const byRun = new Map<string, NoticeRow[]>();
      for (const notice of owed)
        byRun.set(notice.run_id, [...(byRun.get(notice.run_id) ?? []), notice]);
      for (const notices of byRun.values()) yield* mergedCatchUp(sql, notices, applicationId);
    }),
  );
